import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createMemoryConsolidationTask, __setGenerateObjectForTest } from "./memory-consolidation";
import { generateObject } from "ai";
import type { Registry } from "../../provider/index";
import type { BackgroundTaskContext } from "../types";
import { MemoryFileManager } from "../../memory/file-manager";

const mockGenerateObject = mock(
  async () => ({
    object: {
      entries: [
        { title: "Merged Topic", name: "merged", summary: "Consolidated summary" },
      ],
    },
  }),
);

function createMinimalRegistry(): Registry {
  return {
    modelIds: ["test:provider"],
    getModel: mock(() => ({
      model: {},
      displayName: "Test Model",
      limit: { context: 4096, output: 1024 },
      modalities: { input: ["text"], output: ["text"] },
      providerId: "test",
      modelId: "provider",
      qualifiedId: "test:provider",
    })),
    sdkRegistry: {} as never,
    models: new Map(),
  } as unknown as Registry;
}

const tmpDir = resolve(import.meta.dir, "__test_tmp__");

describe("createMemoryConsolidationTask", () => {
  beforeEach(async () => {
    __setGenerateObjectForTest(mockGenerateObject as unknown as typeof generateObject);
    mockGenerateObject.mockReset();
    mockGenerateObject.mockImplementation(
      async () => ({
        object: {
          entries: [
            { title: "Merged Topic", name: "merged", summary: "Consolidated summary" },
          ],
        },
      }),
    );
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    __setGenerateObjectForTest(generateObject as unknown as typeof generateObject);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("skips when index is null (no index file)", async () => {
    const projectRoot = join(tmpDir, "no-index-project");
    const userRoot = join(tmpDir, "no-index-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const registry = createMinimalRegistry();
    const task = createMemoryConsolidationTask(registry, {
      project: projectRoot,
      user: userRoot,
    });

    await task.run({} as BackgroundTaskContext);

    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  test("skips when index has no entries", async () => {
    const projectRoot = join(tmpDir, "empty-index-project");
    const userRoot = join(tmpDir, "empty-index-user");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userRoot, { recursive: true });

    const fileManager = new MemoryFileManager({ project: projectRoot, user: userRoot });
    await fileManager.writeIndex([]);

    const registry = createMinimalRegistry();
    const task = createMemoryConsolidationTask(registry, {
      project: projectRoot,
      user: userRoot,
    });

    await task.run({} as BackgroundTaskContext);

    expect(mockGenerateObject).not.toHaveBeenCalled();
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

    mockGenerateObject.mockImplementation(async () => ({
      object: {
        entries: [
          { title: "Merged Topic", name: "topic1", summary: "Consolidated summary" },
        ],
      },
    }));

    const registry = createMinimalRegistry();
    const task = createMemoryConsolidationTask(registry, {
      project: projectRoot,
      user: userRoot,
    });

    await task.run({} as BackgroundTaskContext);

    expect(mockGenerateObject).toHaveBeenCalledTimes(1);

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

    mockGenerateObject.mockImplementation(async () => ({
      object: {
        entries: [
          { title: "Exists", name: "exists", summary: "Valid entry" },
          { title: "Ghost", name: "ghost", summary: "Nonexistent file" },
        ],
      },
    }));

    const registry = createMinimalRegistry();
    const task = createMemoryConsolidationTask(registry, {
      project: projectRoot,
      user: userRoot,
    });

    await task.run({} as BackgroundTaskContext);

    const newIndex = await fileManager.readIndex();
    expect(newIndex).toContain("exists");
    expect(newIndex).not.toContain("ghost");
  });

  test("leaves old index intact on generateObject validation error", async () => {
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

    const validationError = new Error("Validation failed");
    validationError.name = "AI_TypeValidationError";
    mockGenerateObject.mockRejectedValue(validationError);

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const registry = createMinimalRegistry();
      const task = createMemoryConsolidationTask(registry, {
        project: projectRoot,
        user: userRoot,
      });

      await task.run({} as BackgroundTaskContext);

      const index = await fileManager.readIndex();
      expect(index).toContain("Original summary");
      expect(warnSpy).toHaveBeenCalledWith(
        "Memory consolidation: LLM output validation failed:",
        "Validation failed",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("leaves old index intact on generateObject throw", async () => {
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

    mockGenerateObject.mockRejectedValue(new Error("API error"));

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const registry = createMinimalRegistry();
      const task = createMemoryConsolidationTask(registry, {
        project: projectRoot,
        user: userRoot,
      });

      await task.run({} as BackgroundTaskContext);

      const index = await fileManager.readIndex();
      expect(index).toContain("Original summary");
      expect(warnSpy).toHaveBeenCalledWith(
        "Memory consolidation failed:",
        "API error",
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("calls generateObject with correct prompt containing entries and descriptions", async () => {
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

    mockGenerateObject.mockImplementation(async () => ({
      object: {
        entries: [
          { title: "Authentication", name: "auth", summary: "Auth summary" },
        ],
      },
    }));

    const registry = createMinimalRegistry();
    const task = createMemoryConsolidationTask(registry, {
      project: projectRoot,
      user: userRoot,
    });

    await task.run({} as BackgroundTaskContext);

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Authentication"),
      }),
    );
    expect(mockGenerateObject).toHaveBeenCalledWith(
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

    mockGenerateObject.mockImplementation(async () => ({
      object: {
        entries: [
          { title: "Design Patterns", name: "patterns", summary: "Updated summary" },
        ],
      },
    }));

    const registry = createMinimalRegistry();
    const task = createMemoryConsolidationTask(registry, {
      project: projectRoot,
      user: userRoot,
    });

    await task.run({} as BackgroundTaskContext);

    const newIndex = await fileManager.readIndex();
    expect(newIndex).toContain("Design Patterns");
    expect(newIndex).toContain("patterns");
  });
});
