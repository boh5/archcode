import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSessionStore } from "../../store/store";
import type { StoredMessage } from "../../store/types";
import type { MemoryRoots } from "../../memory/types";
import { MemoryFileManager } from "../../memory/file-manager";
import { __setGenerateTextForTest } from "../../llm";
import { generateText } from "ai";
import { createMemoryExtractionTask } from "./memory-extraction";
import type { ModelInfo } from "../../provider/model";

function makeGenerateTextResult(input: unknown = { memories: [] }) {
  return {
    text: "",
    toolCalls: [
      {
        type: "tool-call" as const,
        toolCallId: "call_1",
          toolName: "result",
        input,
      },
    ],
  };
}

const mockGenerateText = mock(async (_opts: Record<string, unknown>) => makeGenerateTextResult());

const tmpDir = resolve(import.meta.dir, "__test_tmp__");

function makeModelInfo(): ModelInfo {
  return {
    model: { provider: "test" } as never,
    displayName: "Test Model",
    limit: { context: 4096, output: 1024 },
    modalities: { input: ["text"], output: ["text"] },
    providerId: "test",
    modelId: "test-model",
    qualifiedId: "test:test-model",
  };
}

function makeUserMessage(text: string, now: number): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [
      {
        type: "text",
        id: crypto.randomUUID(),
        text,
        createdAt: now,
        completedAt: now,
      },
    ],
    createdAt: now,
    completedAt: now,
  };
}

function makeAssistantMessage(text: string, now: number): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: "text",
        id: crypto.randomUUID(),
        text,
        createdAt: now,
        completedAt: now,
      },
    ],
    createdAt: now,
    completedAt: now,
  };
}

describe("createMemoryExtractionTask", () => {
  beforeEach(async () => {
    __setGenerateTextForTest(mockGenerateText as unknown as typeof generateText);
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({
        memories: [
          {
            title: "User prefers TypeScript",
            name: "typescript_preference",
            description: "User prefers TypeScript over JavaScript",
            type: "user",
            content: "The user prefers TypeScript for all projects.",
            shouldCreate: true,
          },
        ],
      }),
    );
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    __setGenerateTextForTest(generateText as unknown as typeof generateText);
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeMemoryRoots(testName: string): MemoryRoots {
    const projectRoot = join(tmpDir, testName, "project");
    const userRoot = join(tmpDir, testName, "user");
    return { project: projectRoot, user: userRoot };
  }

  async function setupDirs(roots: MemoryRoots): Promise<void> {
    await mkdir(roots.project, { recursive: true });
    await mkdir(roots.user, { recursive: true });
  }

  test("skips extraction when fewer than MIN_MESSAGES_FOR_EXTRACTION user messages", async () => {
    const roots = makeMemoryRoots("skip-few-messages");
    await setupDirs(roots);
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [makeUserMessage("Hi", now)],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("skips extraction when total content length below MIN_CONTENT_LENGTH_FOR_EXTRACTION", async () => {
    const roots = makeMemoryRoots("skip-short-content");
    await setupDirs(roots);
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("Hi", now),
        makeAssistantMessage("Hello", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("extracts user memories to preferences and project memories to topics", async () => {
    const roots = makeMemoryRoots("extract-success");
    await setupDirs(roots);
    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up question", now),
      ],
    });

    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({
        memories: [
          {
            title: "User prefers TypeScript",
            name: "typescript_preference",
            description: "User prefers TypeScript over JavaScript",
            type: "user",
            content: "The user prefers TypeScript for all projects.",
            shouldCreate: true,
          },
          {
            title: "Project Architecture",
            name: "architecture",
            description: "Project uses monorepo",
            type: "project",
            content: "Monorepo structure with shared packages.",
            shouldCreate: true,
          },
        ],
      }),
    );

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);

    // type: "user" should go to user preferences
    const fileManager = new MemoryFileManager(roots);
    const prefs = await fileManager.readPreferences();
    expect(prefs).not.toBeNull();
    expect(prefs).toContain("The user prefers TypeScript for all projects.");

    // type: "project" should go to project knowledge topic
    const topic = await fileManager.readTopic("architecture");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("Project Architecture");
    expect(topic!.type).toBe("project");

    const index = await fileManager.readIndex();
    expect(index).not.toBeNull();
    expect(index).toContain("architecture");
  });

  test("handles llmObject failure gracefully", async () => {
    const roots = makeMemoryRoots("gen-error");
    await setupDirs(roots);
    mockGenerateText.mockRejectedValue(new Error("API error"));

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const now = Date.now();
      const longText = "A".repeat(300);
      const store = createSessionStore(crypto.randomUUID());
      store.setState({
        messages: [
          makeUserMessage(longText, now),
          makeAssistantMessage("Response", now),
          makeUserMessage("Another question", now),
        ],
      });

      const task = createMemoryExtractionTask(store, roots);
      const ctx = {
        store,
        modelInfo: makeModelInfo(),
        workspaceRoot: "/tmp",
      };

      await task.run(ctx as never);

      const fileManager = new MemoryFileManager(roots);
      const topics = await fileManager.listTopics();
      expect(topics).toHaveLength(0);

      expect(warnSpy).toHaveBeenCalledWith(
        "Memory extraction LLM call failed:",
        "API error",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("handles LlmSchemaValidationError gracefully", async () => {
    const roots = makeMemoryRoots("validation-error");
    await setupDirs(roots);
    mockGenerateText.mockImplementation(async () => makeGenerateTextResult({ invalid: "data" }));

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const now = Date.now();
      const longText = "A".repeat(300);
      const store = createSessionStore(crypto.randomUUID());
      store.setState({
        messages: [
          makeUserMessage(longText, now),
          makeAssistantMessage("Response", now),
          makeUserMessage("Follow up", now),
        ],
      });

      const task = createMemoryExtractionTask(store, roots);
      const ctx = {
        store,
        modelInfo: makeModelInfo(),
        workspaceRoot: "/tmp",
      };

      await task.run(ctx as never);

      const fileManager = new MemoryFileManager(roots);
      const topics = await fileManager.listTopics();
      expect(topics).toHaveLength(0);

      expect(warnSpy).toHaveBeenCalledWith(
        "Memory extraction: LLM output validation failed:",
        expect.any(String),
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("handles file write error gracefully and continues with other topics", async () => {
    const roots = makeMemoryRoots("write-error");
    await setupDirs(roots);

    // Creating a directory at the target file path forces writeTopic to fail
    const knowledgeDir = join(roots.project, "knowledge");
    await mkdir(knowledgeDir, { recursive: true });
    await mkdir(join(knowledgeDir, "architecture.md"), { recursive: true });

    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({
        memories: [
          {
            title: "User Preference",
            name: "user_pref",
            description: "User prefers concise code",
            type: "user",
            content: "Prefers concise code.",
            shouldCreate: true,
          },
          {
            title: "Project Architecture",
            name: "architecture",
            description: "Project uses monorepo",
            type: "project",
            content: "Monorepo structure.",
            shouldCreate: true,
          },
        ],
      }),
    );

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const now = Date.now();
      const longText = "A".repeat(300);
      const store = createSessionStore(crypto.randomUUID());
      store.setState({
        messages: [
          makeUserMessage(longText, now),
          makeAssistantMessage("Response", now),
          makeUserMessage("Follow up", now),
        ],
      });

      const task = createMemoryExtractionTask(store, roots);
      const ctx = {
        store,
        modelInfo: makeModelInfo(),
        workspaceRoot: "/tmp",
      };

      await task.run(ctx as never);

      // type: "user" (preferences) should have been written successfully
      const fileManager = new MemoryFileManager(roots);
      const prefs = await fileManager.readPreferences();
      expect(prefs).not.toBeNull();
      expect(prefs).toContain("Prefers concise code.");

      // The project-level topic write should have failed (directory blocks it)
      expect(warnSpy).toHaveBeenCalledWith(
        'Memory extraction: failed to write "architecture":',
        expect.any(String),
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("merges content into existing topic when shouldCreate is false", async () => {
    const roots = makeMemoryRoots("merge-topic");
    await setupDirs(roots);

    const fileManager = new MemoryFileManager(roots);
    await fileManager.writeTopic(
      "architecture",
      { name: "Architecture", description: "Project architecture decisions", type: "project" },
      "The project uses a monorepo structure.",
    );

    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({
        memories: [
          {
            title: "Architecture",
            name: "architecture",
            description: "Updated description",
            type: "project",
            content: "Also uses Turborepo for builds.",
            shouldCreate: false,
          },
        ],
      }),
    );

    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    const topic = await fileManager.readTopic("architecture");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("Architecture");
    expect(topic!.description).toBe("Updated description");
    expect(topic!.content).toBe("The project uses a monorepo structure.\n\n---\n\nAlso uses Turborepo for builds.");
  });

  test("creates new topic when shouldCreate is false but topic does not exist", async () => {
    const roots = makeMemoryRoots("create-new-topic");
    await setupDirs(roots);

    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({
        memories: [
          {
            title: "New Topic",
            name: "new_topic",
            description: "A new topic",
            type: "project",
            content: "Some content",
            shouldCreate: false,
          },
        ],
      }),
    );

    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    const fileManager = new MemoryFileManager(roots);
    const topic = await fileManager.readTopic("new_topic");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("New Topic");
    expect(topic!.type).toBe("project");
    expect(topic!.content).toBe("Some content");
  });

  test("skips writing when LLM returns empty memories array", async () => {
    const roots = makeMemoryRoots("empty-memories");
    await setupDirs(roots);
    mockGenerateText.mockImplementation(async () => makeGenerateTextResult({ memories: [] }));

    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    const fileManager = new MemoryFileManager(roots);
    const topics = await fileManager.listTopics();
    expect(topics).toHaveLength(0);
  });

  test("handles rebuildIndex failure gracefully", async () => {
    const roots = makeMemoryRoots("rebuild-error");
    await setupDirs(roots);

    // Creating a directory at index.md path forces rebuildIndex to fail
    const knowledgeDir = join(roots.project, "knowledge");
    await mkdir(knowledgeDir, { recursive: true });
    await mkdir(join(roots.project, "index.md"), { recursive: true });

    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({
        memories: [
          {
            title: "Project Architecture",
            name: "architecture",
            description: "Project uses monorepo",
            type: "project",
            content: "Monorepo structure.",
            shouldCreate: true,
          },
        ],
      }),
    );

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const now = Date.now();
      const longText = "A".repeat(300);
      const store = createSessionStore(crypto.randomUUID());
      store.setState({
        messages: [
          makeUserMessage(longText, now),
          makeAssistantMessage("Response", now),
          makeUserMessage("Follow up", now),
        ],
      });

      const task = createMemoryExtractionTask(store, roots);
      const ctx = {
        store,
        modelInfo: makeModelInfo(),
        workspaceRoot: "/tmp",
      };

      await task.run(ctx as never);

      const fileManager = new MemoryFileManager(roots);
      const topic = await fileManager.readTopic("architecture");
      expect(topic).not.toBeNull();
      expect(topic!.name).toBe("Project Architecture");

      expect(warnSpy).toHaveBeenCalledWith(
        "Memory extraction: failed to rebuild index:",
        expect.any(String),
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("uses DEFAULT_EXTRACTION_MAX_MESSAGES constant to truncate conversation", async () => {
    const roots = makeMemoryRoots("truncate-conversation");
    await setupDirs(roots);
    const now = Date.now();
    const longText = "A".repeat(300);
    const messages: StoredMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUserMessage(`${longText} - message ${i}`, now + i));
      messages.push(makeAssistantMessage(`Response ${i}`, now + i));
    }

    const store = createSessionStore(crypto.randomUUID());
    store.setState({ messages });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0];
    const callArgs = call[0] as Record<string, unknown>;
    expect(typeof callArgs.prompt).toBe("string");
    // With DEFAULT_EXTRACTION_MAX_MESSAGES = 50, all 10 messages should be included
    expect((callArgs.prompt as string)).toContain("message 9");
  });

  test("uses name directly from LLM result (no prefix stripping needed)", async () => {
    const roots = makeMemoryRoots("use-name-directly");
    await setupDirs(roots);
    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up about debugging", now),
      ],
    });

    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({
        memories: [
          {
            title: "Debugging Tips",
            name: "debugging_tips",
            description: "Common debugging patterns",
            type: "reference",
            content: "Use console.log for quick debugging.",
            shouldCreate: true,
          },
        ],
      }),
    );

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    const fileManager = new MemoryFileManager(roots);
    const topic = await fileManager.readTopic("debugging_tips");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("Debugging Tips");
    expect(topic!.content).toBe("Use console.log for quick debugging.");
  });

  test("skips topics with invalid names (path separators, hyphens)", async () => {
    const roots = makeMemoryRoots("invalid-name");
    await setupDirs(roots);

    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({
        memories: [
          {
            title: "Valid Topic",
            name: "valid_topic",
            description: "A valid topic",
            type: "project",
            content: "Valid content",
            shouldCreate: true,
          },
          {
            title: "Invalid Topic",
            name: "path/separator",
            description: "Invalid name with slash",
            type: "project",
            content: "Should be skipped",
            shouldCreate: true,
          },
          {
            title: "Another Invalid",
            name: "has-hyphen",
            description: "Invalid name with hyphen",
            type: "project",
            content: "Also should be skipped",
            shouldCreate: true,
          },
        ],
      }),
    );

    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      await task.run(ctx as never);

      const fileManager = new MemoryFileManager(roots);
      const validTopic = await fileManager.readTopic("valid_topic");
      expect(validTopic).not.toBeNull();
      expect(validTopic!.content).toBe("Valid content");

      const invalidSlash = await fileManager.readTopic("path/separator");
      expect(invalidSlash).toBeNull();

      const invalidHyphen = await fileManager.readTopic("has-hyphen");
      expect(invalidHyphen).toBeNull();

      const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(warnCalls.some((m: string) => m.includes("path/separator"))).toBe(true);
      expect(warnCalls.some((m: string) => m.includes("has-hyphen"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("skips memories containing secrets", async () => {
    const roots = makeMemoryRoots("secret-skip");
    await setupDirs(roots);

    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({
        memories: [
          {
            title: "Safe Topic",
            name: "safe_topic",
            description: "A safe topic",
            type: "project",
            content: "This is safe project knowledge.",
            shouldCreate: true,
          },
          {
            title: "Leaked Secret",
            name: "leaked_secret",
            description: "Contains a secret",
            type: "project",
            content: "My api_key=sk_test_1234567890abcdef1234567890abcd",
            shouldCreate: true,
          },
          {
            title: "User Secret Pref",
            name: "user_secret",
            description: "User preferences with secret",
            type: "user",
            content: "I use password=mypassword123 for auth",
            shouldCreate: true,
          },
        ],
      }),
    );

    const now = Date.now();
    const longText = "A".repeat(300);
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage(longText, now),
        makeAssistantMessage("Response", now),
        makeUserMessage("Follow up", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      await task.run(ctx as never);

      const fileManager = new MemoryFileManager(roots);

      const safeTopic = await fileManager.readTopic("safe_topic");
      expect(safeTopic).not.toBeNull();
      expect(safeTopic!.content).toBe("This is safe project knowledge.");

      const leakedTopic = await fileManager.readTopic("leaked_secret");
      expect(leakedTopic).toBeNull();

      const prefs = await fileManager.readPreferences();
      expect(prefs).toBeNull();

      const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(warnCalls.some((m: string) => m.includes("leaked_secret"))).toBe(true);
      expect(warnCalls.some((m: string) => m.includes("user_secret"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
