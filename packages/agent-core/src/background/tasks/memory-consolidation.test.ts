import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryConsolidationTask } from "./memory-consolidation";
import { setLlmAdapterForTest } from "../../llm";
import type { ModelInfo } from "../../provider/model";
import type { BackgroundTaskContext } from "../types";
import type { ExecutionModelBinding } from "../../models";
import { MemoryFileManager } from "../../memory/file-manager";
import { createMockLogger } from "../../logger.test-helper";
import { silentLogger } from "../../logger";
import { storeManager } from "../../store/store";
import { createTestTempRoot } from "../../testing/test-temp-root";
import { createFakeRetryScheduler } from "../../testing/fake-retry-scheduler";
import { createTestModelInfo } from "../../testing/test-execution-fixtures";

type MockGenerateTextResult = { text: string; toolCalls: Array<{ type: string; toolCallId: string; toolName: string; input: unknown }> };

function makeGenerateTextResult(
  input: unknown = {
    entries: [
      { title: "Merged Topic", name: "merged", summary: "Consolidated summary" },
    ],
  },
): MockGenerateTextResult {
  return ({
    text: "",
    toolCalls: [
      {
        type: "tool-call" as const,
        toolCallId: "call_1",
        toolName: "result",
        input,
      },
    ],
  }) as unknown as MockGenerateTextResult;
}

const mockGenerateText = mock(async () => makeGenerateTextResult());

function makeModelInfo(): ModelInfo {
  return createTestModelInfo();
}

function makeBinding(options?: ExecutionModelBinding["options"]): ExecutionModelBinding {
  const modelInfo = makeModelInfo();
  return { modelInfo, options, summary: {
    selection: { model: modelInfo.qualifiedId }, providerId: modelInfo.providerId, modelId: modelInfo.modelId,
    providerDisplayName: modelInfo.providerDisplayName, modelDisplayName: modelInfo.displayName,
    resolution: "agent_default", modelRuntimeRevision: "test-revision",
  } };
}

function makeTaskContext(overrides: Partial<BackgroundTaskContext> = {}): BackgroundTaskContext {
  return { store: storeManager.create(crypto.randomUUID(), tmpDir, { agentName: "engineer" }),
  binding: makeBinding(),
  logger: silentLogger,
  retryScheduler: createFakeRetryScheduler(),
  workspaceRoot: "/tmp", ...overrides,  };
}

const testTemp = createTestTempRoot("memory-consolidation-task");
const tmpDir = testTemp.path;

describe("createMemoryConsolidationTask", () => {
  beforeEach(async () => {
    setLlmAdapterForTest({ generateText: mockGenerateText as unknown as typeof import("ai").generateText });
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () => makeGenerateTextResult());
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    setLlmAdapterForTest(undefined);
    await testTemp.cleanup();
  });

  test("skips when index is null (no index file)", async () => {
    const projectRoot = join(tmpDir, "no-index-project");
    const userRoot = join(tmpDir, "no-index-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const task = createMemoryConsolidationTask({
      project: projectRoot,
      user: userRoot,
    });

    await task.run(makeTaskContext());

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("skips when index has no entries", async () => {
    const projectRoot = join(tmpDir, "empty-index-project");
    const userRoot = join(tmpDir, "empty-index-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const fileManager = new MemoryFileManager({ project: projectRoot, user: userRoot });
    await fileManager.writeIndex([]);

    const task = createMemoryConsolidationTask({
      project: projectRoot,
      user: userRoot,
    });

    await task.run(makeTaskContext());

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("consolidates index and writes valid entries", async () => {
    const projectRoot = join(tmpDir, "consolidate-project");
    const userRoot = join(tmpDir, "consolidate-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const fileManager = new MemoryFileManager({ project: projectRoot, user: userRoot });

    await fileManager.writeTopic(
      "topic1",
      { name: "Topic 1", description: "First topic", type: "project" },
      "Content for topic 1",
    );
    await fileManager.writeTopic(
      "topic2",
      { name: "Topic 2", description: "Second topic", type: "project" },
      "Content for topic 2",
    );

    await fileManager.writeIndex([
      { title: "Topic 1", name: "topic1", summary: "First topic summary" },
      { title: "Topic 2", name: "topic2", summary: "Second topic summary" },
    ]);

    mockGenerateText.mockImplementation(async () => makeGenerateTextResult({
      entries: [
        { title: "Merged Topic", name: "topic1", summary: "Consolidated summary" },
      ],
    }));

    const task = createMemoryConsolidationTask({
      project: projectRoot,
      user: userRoot,
    });

    await task.run(makeTaskContext({
      binding: makeBinding({
        temperature: 0.15,
        maxOutputTokens: 96,
        providerOptions: { memoryConsolidation: { mode: "compact" } },
      }),
    }));

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.15,
        maxOutputTokens: 96,
        providerOptions: { memoryConsolidation: { mode: "compact" } },
      }),
    );

    const newIndex = await fileManager.readIndex();
    expect(newIndex).toContain("Merged Topic");
    expect(newIndex).toContain("topic1");
  });

  test("filters out entries referencing nonexistent files", async () => {
    const projectRoot = join(tmpDir, "filter-project");
    const userRoot = join(tmpDir, "filter-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const fileManager = new MemoryFileManager({ project: projectRoot, user: userRoot });

    await fileManager.writeTopic(
      "exists",
      { name: "Exists", description: "Real topic", type: "project" },
      "Content",
    );

    await fileManager.writeIndex([
      { title: "Exists", name: "exists", summary: "Real entry" },
    ]);

    mockGenerateText.mockImplementation(async () => makeGenerateTextResult({
      entries: [
        { title: "Exists", name: "exists", summary: "Valid entry" },
        { title: "Ghost", name: "ghost", summary: "Nonexistent file" },
      ],
    }));

    const task = createMemoryConsolidationTask({
      project: projectRoot,
      user: userRoot,
    });

    await task.run(makeTaskContext());

    const newIndex = await fileManager.readIndex();
    expect(newIndex).toContain("exists");
    expect(newIndex).not.toContain("ghost");
  });

  test("leaves old index intact on LlmSchemaValidationError", async () => {
    const projectRoot = join(tmpDir, "validation-error-project");
    const userRoot = join(tmpDir, "validation-error-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const fileManager = new MemoryFileManager({ project: projectRoot, user: userRoot });

    await fileManager.writeTopic(
      "topic1",
      { name: "Topic 1", description: "Desc", type: "project" },
      "Content",
    );
    await fileManager.writeIndex([
      { title: "Topic 1", name: "topic1", summary: "Original summary" },
    ]);

    // Return invalid tool-call input that fails schema parsing,
    // causing llmObject to throw LlmSchemaValidationError
    mockGenerateText.mockImplementation(async () =>
      makeGenerateTextResult({ invalid: "data" }),
    );

    const logger = createMockLogger();

    try {
      const task = createMemoryConsolidationTask({
        project: projectRoot,
        user: userRoot,
      });

      await task.run(makeTaskContext({ logger }));

      const index = await fileManager.readIndex();
      expect(index).toContain("Original summary");
      expect(logger.warn).toHaveBeenCalledWith("memory.consolidation.validation.failed", expect.objectContaining({
        error: expect.any(Error),
      }));
    } finally {
    }
  });

  test("leaves old index intact on generateText throw", async () => {
    const projectRoot = join(tmpDir, "throw-project");
    const userRoot = join(tmpDir, "throw-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const fileManager = new MemoryFileManager({ project: projectRoot, user: userRoot });

    await fileManager.writeTopic(
      "topic1",
      { name: "Topic 1", description: "Desc", type: "project" },
      "Content",
    );
    await fileManager.writeIndex([
      { title: "Topic 1", name: "topic1", summary: "Original summary" },
    ]);

    mockGenerateText.mockRejectedValue(new Error("API error"));

    const logger = createMockLogger();
    const retryScheduler = createFakeRetryScheduler();

    try {
      const task = createMemoryConsolidationTask({
        project: projectRoot,
        user: userRoot,
      });

      await task.run(makeTaskContext({ logger, retryScheduler }));

      const index = await fileManager.readIndex();
      expect(index).toContain("Original summary");
      expect(retryScheduler.sleeps).toHaveLength(2);
      expect(logger.warn).toHaveBeenCalledWith("memory.consolidation.failed", expect.objectContaining({
        error: expect.any(Error),
      }));
    } finally {
    }
  });

  test("calls generateText with correct prompt containing entries and descriptions", async () => {
    const projectRoot = join(tmpDir, "prompt-project");
    const userRoot = join(tmpDir, "prompt-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const fileManager = new MemoryFileManager({ project: projectRoot, user: userRoot });

    await fileManager.writeTopic(
      "auth",
      { name: "Authentication", description: "Login and auth flows", type: "project" },
      "Content about auth",
    );
    await fileManager.writeIndex([
      { title: "Authentication", name: "auth", summary: "Login flows" },
    ]);

    mockGenerateText.mockImplementation(async () => makeGenerateTextResult({
      entries: [
        { title: "Authentication", name: "auth", summary: "Auth summary" },
      ],
    }));

    const task = createMemoryConsolidationTask({
      project: projectRoot,
      user: userRoot,
    });

    await task.run(makeTaskContext());

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Authentication"),
      }),
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("auth"),
      }),
    );
  });

  test("uses name directly from index entry (no prefix stripping needed)", async () => {
    const projectRoot = join(tmpDir, "use-name-directly");
    const userRoot = join(tmpDir, "use-name-directly");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const fileManager = new MemoryFileManager({ project: projectRoot, user: userRoot });

    await fileManager.writeTopic(
      "patterns",
      { name: "Design Patterns", description: "Common design patterns", type: "project" },
      "Content about patterns",
    );
    await fileManager.writeIndex([
      { title: "Design Patterns", name: "patterns", summary: "Patterns summary" },
    ]);

    mockGenerateText.mockImplementation(async () => makeGenerateTextResult({
      entries: [
        { title: "Design Patterns", name: "patterns", summary: "Updated summary" },
      ],
    }));

    const task = createMemoryConsolidationTask({
      project: projectRoot,
      user: userRoot,
    });

    await task.run(makeTaskContext());

    const newIndex = await fileManager.readIndex();
    expect(newIndex).toContain("Design Patterns");
    expect(newIndex).toContain("patterns");
  });
});
