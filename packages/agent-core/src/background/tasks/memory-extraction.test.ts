import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { storeManager } from "../../store/store";
import type { StoredMessage } from "../../store/types";
import type { MemoryRoots } from "../../memory/types";
import { MemoryFileManager } from "../../memory/file-manager";
import { setLlmAdapterForTest } from "../../llm";
import { createMemoryExtractionTask, filterMessagesForExtraction } from "./memory-extraction";
import { buildMemoryManifest } from "../../memory/manifest";
import type { ModelInfo } from "../../provider/model";
import { createMockLogger } from "../../logger.test-helper";
import { silentLogger } from "../../logger";
import type { BackgroundTaskContext } from "../types";

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

function makeTaskContext(
  store: ReturnType<typeof storeManager.create>,
  overrides: Partial<BackgroundTaskContext> = {},
): BackgroundTaskContext {
  return { store,
  modelInfo: makeModelInfo(),
  logger: silentLogger,
  workspaceRoot: "/tmp", ...overrides,  };
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

function makeUserMessages(count: number, text = "A".repeat(300), now = Date.now()): StoredMessage[] {
  return Array.from({ length: count }, (_, index) => makeUserMessage(`${text}${index}`, now + index));
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

function makeToolMessage(toolName: string, output: string, now: number): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: "tool",
        id: crypto.randomUUID(),
        state: "completed",
        toolCallId: crypto.randomUUID(),
        toolName,
        input: { path: "/tmp/test.ts" },
        output,
        createdAt: now,
        startedAt: now,
        endedAt: now,
      },
    ],
    createdAt: now,
    completedAt: now,
  };
}

describe("createMemoryExtractionTask", () => {
  beforeEach(async () => {
    setLlmAdapterForTest({ generateText: mockGenerateText as unknown as typeof import("ai").generateText });
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
    setLlmAdapterForTest(undefined);
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
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [makeUserMessage("Hi", now)],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = makeTaskContext(store, {
      modelOptions: {
        temperature: 0.55,
        maxOutputTokens: 256,
        providerOptions: { memoryExtraction: { mode: "archive" } },
      },
    });

    await task.run(ctx);

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("skips extraction when total content length below MIN_CONTENT_LENGTH_FOR_EXTRACTION", async () => {
    const roots = makeMemoryRoots("skip-short-content");
    await setupDirs(roots);
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("Hi", now),
        makeAssistantMessage("Hello", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = makeTaskContext(store, {
      modelOptions: {
        temperature: 0.55,
        maxOutputTokens: 256,
        providerOptions: { memoryExtraction: { mode: "archive" } },
      },
    });

    await task.run(ctx);

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("extracts user memories to preferences and project memories to topics", async () => {
    const roots = makeMemoryRoots("extract-success");
    await setupDirs(roots);
    const now = Date.now();
    const longText = "A".repeat(300);
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: makeUserMessages(5, longText, now),
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
    const ctx = makeTaskContext(store, {
      modelOptions: {
        temperature: 0.55,
        maxOutputTokens: 256,
        providerOptions: { memoryExtraction: { mode: "archive" } },
      },
    });

    await task.run(ctx);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.55,
        maxOutputTokens: 256,
        providerOptions: { memoryExtraction: { mode: "archive" } },
      }),
    );

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

    const logger = createMockLogger();

    try {
      const now = Date.now();
      const longText = "A".repeat(300);
      const store = storeManager.create(crypto.randomUUID());
      store.setState({
        messages: [
          ...makeUserMessages(5, longText, now),
        ],
      });

      const task = createMemoryExtractionTask(store, roots);
      const ctx = makeTaskContext(store, { logger });

      await task.run(ctx);

      const fileManager = new MemoryFileManager(roots);
      const topics = await fileManager.listTopics();
      expect(topics).toHaveLength(0);

      expect(logger.warn).toHaveBeenCalledWith("memory.extraction.llm.failed", expect.objectContaining({
        error: expect.any(Error),
        context: { sessionId: store.getState().sessionId },
      }));
    } finally {
    }
  });

  test("bounded memory retry final failure is non-blocking and not chat-visible", async () => {
    const roots = makeMemoryRoots("retry-final-failure");
    await setupDirs(roots);
    mockGenerateText.mockRejectedValue(new Error("provider unavailable"));
    const logger = createMockLogger();
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID());
    store.setState({ messages: makeUserMessages(5, "A".repeat(300), now) });

    await createMemoryExtractionTask(store, roots).run(makeTaskContext(store, { logger }));

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(store.getState().messages).toHaveLength(5);
    expect(JSON.stringify(store.getState().messages)).not.toContain("recovery-notice");
    expect(await new MemoryFileManager(roots).listTopics()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith("memory.extraction.llm.failed", expect.objectContaining({ error: expect.any(Error) }));
  });

  test("handles LlmSchemaValidationError gracefully", async () => {
    const roots = makeMemoryRoots("validation-error");
    await setupDirs(roots);
    mockGenerateText.mockImplementation(async () => makeGenerateTextResult({ invalid: "data" }));

    const logger = createMockLogger();

    try {
      const now = Date.now();
      const longText = "A".repeat(300);
      const store = storeManager.create(crypto.randomUUID());
      store.setState({
        messages: [
          ...makeUserMessages(5, longText, now),
        ],
      });

      const task = createMemoryExtractionTask(store, roots);
      const ctx = makeTaskContext(store, { logger });

      await task.run(ctx);

      const fileManager = new MemoryFileManager(roots);
      const topics = await fileManager.listTopics();
      expect(topics).toHaveLength(0);

      expect(logger.warn).toHaveBeenCalledWith("memory.extraction.llm.validation.failed", expect.objectContaining({
        error: expect.any(Error),
        context: { sessionId: store.getState().sessionId },
      }));
    } finally {
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

    const logger = createMockLogger();

    try {
      const now = Date.now();
      const longText = "A".repeat(300);
      const store = storeManager.create(crypto.randomUUID());
      store.setState({
        messages: [
          ...makeUserMessages(5, longText, now),
        ],
      });

      const task = createMemoryExtractionTask(store, roots);
      const ctx = makeTaskContext(store, { logger });

      await task.run(ctx);

      // type: "user" (preferences) should have been written successfully
      const fileManager = new MemoryFileManager(roots);
      const prefs = await fileManager.readPreferences();
      expect(prefs).not.toBeNull();
      expect(prefs).toContain("Prefers concise code.");

      // The project-level topic write should have failed (directory blocks it)
      expect(logger.warn).toHaveBeenCalledWith("memory.extraction.write.failed", expect.objectContaining({
        error: expect.any(Error),
        context: { sessionId: store.getState().sessionId },
        meta: { memoryName: "architecture", memoryType: "project" },
      }));
    } finally {
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
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        ...makeUserMessages(5, longText, now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = makeTaskContext(store);

    await task.run(ctx);

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
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        ...makeUserMessages(5, longText, now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = makeTaskContext(store);

    await task.run(ctx);

    const fileManager = new MemoryFileManager(roots);
    const topic = await fileManager.readTopic("new_topic");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("New Topic");
    expect(topic!.type).toBe("project");
    expect(topic!.content).toBe("Some content");
  });

  test("merges content when shouldCreate is true but topic already exists (write safety net)", async () => {
    const roots = makeMemoryRoots("safety-net-merge");
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
            description: "Updated architecture decisions",
            type: "project",
            content: "Also uses Turborepo for builds.",
            // shouldCreate: true, but topic already exists — should merge, not overwrite
            shouldCreate: true,
          },
        ],
      }),
    );

    const now = Date.now();
    const longText = "A".repeat(300);
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        ...makeUserMessages(5, longText, now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = makeTaskContext(store);

    await task.run(ctx);

    const topic = await fileManager.readTopic("architecture");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("Architecture");
    // Content should be merged, not overwritten
    expect(topic!.content).toBe("The project uses a monorepo structure.\n\n---\n\nAlso uses Turborepo for builds.");
  });

  test("skips writing when LLM returns empty memories array", async () => {
    const roots = makeMemoryRoots("empty-memories");
    await setupDirs(roots);
    mockGenerateText.mockImplementation(async () => makeGenerateTextResult({ memories: [] }));

    const now = Date.now();
    const longText = "A".repeat(300);
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        ...makeUserMessages(5, longText, now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = makeTaskContext(store);

    await task.run(ctx);

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

    const logger = createMockLogger();

    try {
      const now = Date.now();
      const longText = "A".repeat(300);
      const store = storeManager.create(crypto.randomUUID());
      store.setState({
        messages: [
          ...makeUserMessages(5, longText, now),
        ],
      });

      const task = createMemoryExtractionTask(store, roots);
      const ctx = makeTaskContext(store, { logger });

      await task.run(ctx);

      const fileManager = new MemoryFileManager(roots);
      const topic = await fileManager.readTopic("architecture");
      expect(topic).not.toBeNull();
      expect(topic!.name).toBe("Project Architecture");

      expect(logger.warn).toHaveBeenCalledWith("memory.extraction.index.failed", expect.objectContaining({
        error: expect.any(Error),
        context: { sessionId: store.getState().sessionId },
      }));
    } finally {
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

    const store = storeManager.create(crypto.randomUUID());
    store.setState({ messages });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = makeTaskContext(store);

    await task.run(ctx);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0];
    const callArgs = call[0] as Record<string, unknown>;
    expect(typeof callArgs.prompt).toBe("string");
    // With DEFAULT_EXTRACTION_MAX_MESSAGES = 50, all 10 user messages should be included
    expect((callArgs.prompt as string)).toContain("message 9");
  });

  test("only processes messages from fromIndex onwards", async () => {
    const roots = makeMemoryRoots("from-index");
    await setupDirs(roots);
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("OLD_SHOULD_NOT_APPEAR".repeat(100), now),
        makeUserMessage("A".repeat(300), now),
        makeUserMessage("B".repeat(300), now),
        makeUserMessage("C".repeat(300), now),
        makeUserMessage("D".repeat(300), now),
        makeUserMessage("E".repeat(300), now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots, 1);
    await task.run(makeTaskContext(store));

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const prompt = (mockGenerateText.mock.calls[0][0] as Record<string, unknown>).prompt as string;
    expect(prompt).not.toContain("OLD_SHOULD_NOT_APPEAR");
  });

  test("respects custom minMessages and minContentLength from config", async () => {
    const roots = makeMemoryRoots("custom-config");
    await setupDirs(roots);
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("Short message", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots, 0, {
      minMessages: 1,
      minContentLength: 10,
    });
    await task.run(makeTaskContext(store));

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  test("skips extraction when custom minMessages not met", async () => {
    const roots = makeMemoryRoots("custom-config-min-messages");
    await setupDirs(roots);
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("A".repeat(300), now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots, 0, {
      minMessages: 3,
      minContentLength: 100,
    });
    await task.run(makeTaskContext(store));

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("skips extraction when custom minContentLength not met", async () => {
    const roots = makeMemoryRoots("custom-config-min-content");
    await setupDirs(roots);
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("Hi", now),
        makeUserMessage("Hello", now),
        makeUserMessage("Hey", now),
        makeUserMessage("Yo", now),
        makeUserMessage("Sup", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots, 0, {
      minMessages: 2,
      minContentLength: 5000,
    });
    await task.run(makeTaskContext(store));

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("updates lastExtractionIndex after successful llm extraction even with empty memories", async () => {
    const roots = makeMemoryRoots("task-cursor-update");
    await setupDirs(roots);
    mockGenerateText.mockImplementation(async () => makeGenerateTextResult({ memories: [] }));
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("A".repeat(300), now),
        makeUserMessage("B".repeat(300), now),
        makeUserMessage("C".repeat(300), now),
        makeUserMessage("D".repeat(300), now),
        makeUserMessage("E".repeat(300), now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    await task.run(makeTaskContext(store));

    expect(store.getState().lastExtractionIndex).toBe(5);
  });

  test("filters assistant text, write tool results, and keeps read tool output", async () => {
    const roots = makeMemoryRoots("filter-prompt");
    await setupDirs(roots);
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        makeUserMessage("User preference ".repeat(80), now),
        makeUserMessage("Project convention ".repeat(80), now),
        makeUserMessage("Third message ".repeat(80), now),
        makeUserMessage("Fourth message ".repeat(80), now),
        makeUserMessage("Fifth message ".repeat(80), now),
        makeAssistantMessage("ASSISTANT_TEXT_SHOULD_NOT_APPEAR", now),
        makeToolMessage("file_read", "READ_RESULT_SHOULD_APPEAR", now),
        makeToolMessage("file_write", "WRITE_RESULT_SHOULD_NOT_APPEAR", now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    await task.run(makeTaskContext(store));

    const prompt = (mockGenerateText.mock.calls[0][0] as Record<string, unknown>).prompt as string;
    expect(prompt).not.toContain("ASSISTANT_TEXT_SHOULD_NOT_APPEAR");
    expect(prompt).toContain("READ_RESULT_SHOULD_APPEAR");
    expect(prompt).not.toContain("WRITE_RESULT_SHOULD_NOT_APPEAR");
  });

  test("filterMessagesForExtraction keeps and truncates only extraction-worthy content", () => {
    const now = Date.now();
    const longUserText = "U".repeat(4500);
    const longReadOutput = "R".repeat(1200);
    const messages = [
      makeUserMessage(longUserText, now),
      makeAssistantMessage("assistant text", now),
      makeToolMessage("grep", longReadOutput, now),
      makeToolMessage("bash", "write output", now),
      makeToolMessage("unknown_tool", "unknown output", now),
    ];

    const filtered = filterMessagesForExtraction(messages);

    expect(filtered).toHaveLength(2);
    expect(filtered[0].parts[0].type).toBe("text");
    expect((filtered[0].parts[0] as { text: string }).text).toHaveLength(4000);
    expect(filtered[1].parts[0].type).toBe("tool");
    expect((filtered[1].parts[0] as { output: string }).output).toHaveLength(1000);
    expect(JSON.stringify(filtered)).not.toContain("assistant text");
    expect(JSON.stringify(filtered)).not.toContain("write output");
    expect(JSON.stringify(filtered)).not.toContain("unknown output");
  });

  test("filterMessagesForExtraction keeps user text but skips assistant text", () => {
    const now = Date.now();
    const filtered = filterMessagesForExtraction([
      makeUserMessage("user text", now),
      makeAssistantMessage("assistant text", now),
    ]);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].role).toBe("user");
    expect((filtered[0].parts[0] as { text: string }).text).toBe("user text");
  });

  test("filterMessagesForExtraction skips interrupted user text so memory cannot learn discarded partial context", () => {
    const now = Date.now();
    const interrupted = makeUserMessage("INTERRUPTED_TEXT_SHOULD_NOT_APPEAR", now);
    const text = interrupted.parts[0];
    if (text.type !== "text") throw new Error("Expected text part");
    text.meta = { interrupted: true, discardedFromContext: true };

    const filtered = filterMessagesForExtraction([
      interrupted,
      makeUserMessage("safe text", now + 1),
    ]);

    expect(JSON.stringify(filtered)).not.toContain("INTERRUPTED_TEXT_SHOULD_NOT_APPEAR");
    expect(JSON.stringify(filtered)).toContain("safe text");
  });

  test("uses name directly from LLM result (no prefix stripping needed)", async () => {
    const roots = makeMemoryRoots("use-name-directly");
    await setupDirs(roots);
    const now = Date.now();
    const longText = "A".repeat(300);
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        ...makeUserMessages(5, longText, now),
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
    const ctx = makeTaskContext(store);

    await task.run(ctx);

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
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        ...makeUserMessages(5, longText, now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const logger = createMockLogger();
    const ctx = makeTaskContext(store, { logger });

    try {
      await task.run(ctx);

      const fileManager = new MemoryFileManager(roots);
      const validTopic = await fileManager.readTopic("valid_topic");
      expect(validTopic).not.toBeNull();
      expect(validTopic!.content).toBe("Valid content");

      const invalidSlash = await fileManager.readTopic("path/separator");
      expect(invalidSlash).toBeNull();

      const invalidHyphen = await fileManager.readTopic("has-hyphen");
      expect(invalidHyphen).toBeNull();

      expect(logger.warn).toHaveBeenCalledWith("memory.extraction.topic.invalid", expect.objectContaining({
        context: { sessionId: store.getState().sessionId },
        meta: { memoryName: "path/separator" },
      }));
      expect(logger.warn).toHaveBeenCalledWith("memory.extraction.topic.invalid", expect.objectContaining({
        context: { sessionId: store.getState().sessionId },
        meta: { memoryName: "has-hyphen" },
      }));
    } finally {
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
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        ...makeUserMessages(5, longText, now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const logger = createMockLogger();
    const ctx = makeTaskContext(store, { logger });

    try {
      await task.run(ctx);

      const fileManager = new MemoryFileManager(roots);

      const safeTopic = await fileManager.readTopic("safe_topic");
      expect(safeTopic).not.toBeNull();
      expect(safeTopic!.content).toBe("This is safe project knowledge.");

      const leakedTopic = await fileManager.readTopic("leaked_secret");
      expect(leakedTopic).toBeNull();

      const prefs = await fileManager.readPreferences();
      expect(prefs).toBeNull();

      expect(logger.warn).toHaveBeenCalledWith("memory.extraction.secret.skipped", expect.objectContaining({
        context: { sessionId: store.getState().sessionId },
        meta: expect.objectContaining({ memoryName: "leaked_secret" }),
      }));
      expect(logger.warn).toHaveBeenCalledWith("memory.extraction.secret.skipped", expect.objectContaining({
        context: { sessionId: store.getState().sessionId },
        meta: expect.objectContaining({ memoryName: "user_secret" }),
      }));
    } finally {
    }
  });

  test("injects existing memories manifest into extraction prompt", async () => {
    const roots = makeMemoryRoots("manifest-in-prompt");
    await setupDirs(roots);

    const fileManager = new MemoryFileManager(roots);
    await fileManager.writeTopic("existing_topic", {
      name: "Existing Topic",
      description: "Already known convention",
      type: "project",
    }, "Use bun instead of npm.");
    await fileManager.rebuildIndex();

    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({ memories: [] }),
    );

    const now = Date.now();
    const longText = "A".repeat(300);
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        ...makeUserMessages(5, longText, now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = makeTaskContext(store);

    await task.run(ctx);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0];
    const callArgs = call[0] as Record<string, unknown>;
    const prompt = callArgs.prompt as string;
    expect(prompt).toContain("Existing memories");
    expect(prompt).toContain('name: "existing_topic"');
    expect(prompt).toContain("Deduplication rules");
  });

  test("continues extraction even when manifest build encounters errors", async () => {
    const roots = makeMemoryRoots("manifest-failure");
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
            shouldCreate: true,
          },
        ],
      }),
    );

    const now = Date.now();
    const longText = "A".repeat(300);
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        ...makeUserMessages(5, longText, now),
      ],
    });

    const task = createMemoryExtractionTask(store, roots);
    const ctx = makeTaskContext(store);

    await task.run(ctx);

    expect(mockGenerateText).toHaveBeenCalled();

    const fileManager = new MemoryFileManager(roots);
    const topic = await fileManager.readTopic("new_topic");
    expect(topic).not.toBeNull();
    expect(topic!.name).toBe("New Topic");
  });
});

describe("buildMemoryManifest", () => {
  const tmpDirManifest = resolve(import.meta.dir, "__test_tmp_manifest__");

  afterEach(async () => {
    await rm(tmpDirManifest, { recursive: true, force: true });
  });

  function makeMemoryRoots(testName: string): MemoryRoots {
    const projectRoot = join(tmpDirManifest, testName, "project");
    const userRoot = join(tmpDirManifest, testName, "user");
    return { project: projectRoot, user: userRoot };
  }

  async function setupDirsWithKnowledge(roots: MemoryRoots): Promise<MemoryFileManager> {
    await mkdir(roots.project, { recursive: true });
    await mkdir(join(roots.project, "knowledge"), { recursive: true });
    await mkdir(roots.user, { recursive: true });

    const fm = new MemoryFileManager(roots);

    await fm.writeTopic("typescript_conventions", {
      name: "TypeScript Conventions",
      description: "Project uses strict TypeScript with ES2022",
      type: "project",
    }, "The project uses TypeScript strict mode. All imports use bundler resolution. No .js extensions in imports.");

    await fm.writeTopic("api_patterns", {
      name: "API Patterns",
      description: "REST API design conventions",
      type: "reference",
    }, "All API endpoints follow REST conventions. Use Zod for request/response validation.");

    await fm.writePreferences("The user prefers dark mode for all IDEs.\n\n---\n\nThe user prefers concise commits.");
    await fm.rebuildIndex();

    return fm;
  }

  test("returns empty string when no memories exist", async () => {
    const roots = makeMemoryRoots("empty");
    await mkdir(roots.project, { recursive: true });
    await mkdir(roots.user, { recursive: true });

    const fm = new MemoryFileManager(roots);
    const manifest = await buildMemoryManifest(fm);

    expect(manifest).toBe("");
  });

  test("includes preferences in manifest", async () => {
    const roots = makeMemoryRoots("prefs-only");
    await mkdir(roots.project, { recursive: true });
    await mkdir(roots.user, { recursive: true });

    const fm = new MemoryFileManager(roots);
    await fm.writePreferences("The user prefers dark mode for all IDEs.");

    const manifest = await buildMemoryManifest(fm);
    expect(manifest).toContain("[user preferences]");
    expect(manifest).toContain("dark mode");
  });

  test("includes knowledge topics with name/title/summary format", async () => {
    const roots = makeMemoryRoots("topics-only");
    await mkdir(roots.project, { recursive: true });
    await mkdir(join(roots.project, "knowledge"), { recursive: true });
    await mkdir(roots.user, { recursive: true });

    const fm = new MemoryFileManager(roots);
    await fm.writeTopic("typescript_conventions", {
      name: "TypeScript Conventions",
      description: "Strict TypeScript config",
      type: "project",
    }, "Use strict mode.");
    await fm.rebuildIndex();

    const manifest = await buildMemoryManifest(fm);
    expect(manifest).toContain("[existing knowledge topics]");
    expect(manifest).toContain('name: "typescript_conventions"');
    expect(manifest).toContain('title: "TypeScript Conventions"');
    expect(manifest).toContain('summary: "Strict TypeScript config"');
  });

  test("includes both preferences and topics in manifest", async () => {
    const roots = makeMemoryRoots("full-manifest");
    const fm = await setupDirsWithKnowledge(roots);

    const manifest = await buildMemoryManifest(fm);

    expect(manifest).toContain("[user preferences]");
    expect(manifest).toContain("[existing knowledge topics]");
    expect(manifest).toContain('name: "typescript_conventions"');
    expect(manifest).toContain('name: "api_patterns"');
    expect(manifest).toContain('title: "TypeScript Conventions"');
    expect(manifest).toContain('title: "API Patterns"');
  });

  test("truncates long preferences in manifest", async () => {
    const roots = makeMemoryRoots("long-prefs");
    await mkdir(roots.project, { recursive: true });
    await mkdir(roots.user, { recursive: true });

    const fm = new MemoryFileManager(roots);
    const longPrefs = "y".repeat(500);
    await fm.writePreferences(longPrefs);

    const manifest = await buildMemoryManifest(fm);
    expect(manifest).toContain("[user preferences]");
    expect(manifest).toContain("...");
  });

  test("truncates manifest to max chars", async () => {
    const roots = makeMemoryRoots("truncation");
    await mkdir(roots.project, { recursive: true });
    await mkdir(join(roots.project, "knowledge"), { recursive: true });
    await mkdir(roots.user, { recursive: true });

    const fm = new MemoryFileManager(roots);
    for (let i = 0; i < 50; i++) {
      await fm.writeTopic(`topic_${i}`, {
        name: `Topic ${i}`,
        description: `A topic description ${"x".repeat(100)}`,
        type: "project",
      }, "Content");
    }
    await fm.rebuildIndex();

    const manifest = await buildMemoryManifest(fm);
    expect(manifest).toContain("<!-- manifest truncated -->");
  });
});
