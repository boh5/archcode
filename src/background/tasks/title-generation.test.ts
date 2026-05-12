import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateObject } from "ai";
import { createSessionStore } from "../../store/store";
import { __setGenerateObjectForTest } from "./title-generation";

const TEST_TMP = join(import.meta.dir, "__test_tmp__", "title-generation");

const mockGenerateObject = mock(
  async () => ({ object: { title: "Short test title" } }),
);

import { createTitleGenerationTask } from "./title-generation";
import type { Registry } from "../../provider/index";

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

describe("createTitleGenerationTask", () => {
  beforeEach(async () => {
    __setGenerateObjectForTest(mockGenerateObject as unknown as typeof generateObject);
    mockGenerateObject.mockReset();
    mockGenerateObject.mockImplementation(
      async () => ({ object: { title: "Short test title" } }),
    );
    await mkdir(TEST_TMP, { recursive: true });
  });

  afterEach(() => {
    __setGenerateObjectForTest(generateObject as unknown as typeof generateObject);
  });

  afterAll(async () => {
    await rm(TEST_TMP, { recursive: true, force: true });
  });

  test("generates title and sets it in store on success", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              id: crypto.randomUUID(),
              text: "How do I implement authentication?",
              createdAt: now,
              completedAt: now,
            },
          ],
          createdAt: now,
          completedAt: now,
        },
      ],
    });

    const registry = createMinimalRegistry();
    const task = createTitleGenerationTask(store, registry);
    const ctx = {
      store,
      modelInfo: registry.getModel("test:provider"),
      providerRegistry: registry,
      workspaceRoot: "/tmp",
      sessionsDir: TEST_TMP,
    };

    await task.run(ctx as never);

    expect(store.getState().title).toBe("Short test title");
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("authentication"),
      }),
    );
  });

  test("does nothing when no user message exists", async () => {
    const store = createSessionStore(crypto.randomUUID());
    store.setState({ messages: [] });

    const registry = createMinimalRegistry();
    const task = createTitleGenerationTask(store, registry);
    const ctx = {
      store,
      modelInfo: registry.getModel("test:provider"),
      providerRegistry: registry,
      workspaceRoot: "/tmp",
      sessionsDir: TEST_TMP,
    };

    await task.run(ctx as never);

    expect(store.getState().title).toBeNull();
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  test("handles generateObject failure gracefully", async () => {
    mockGenerateObject.mockRejectedValue(new Error("API error"));

    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              id: crypto.randomUUID(),
              text: "Hello world",
              createdAt: now,
              completedAt: now,
            },
          ],
          createdAt: now,
          completedAt: now,
        },
      ],
    });

    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const registry = createMinimalRegistry();
      const task = createTitleGenerationTask(store, registry);
      const ctx = {
        store,
        modelInfo: registry.getModel("test:provider"),
        providerRegistry: registry,
        workspaceRoot: "/tmp",
        sessionsDir: TEST_TMP,
      };

      await task.run(ctx as never);

      expect(store.getState().title).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "Title generation failed:",
        "API error",
      );
    } finally {
      console.warn = originalWarn;
      mockGenerateObject.mockImplementation(
        async () => ({ object: { title: "Short test title" } }),
      );
    }
  });

  test("does nothing when user message has no text parts", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    store.setState({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [],
          createdAt: now,
          completedAt: now,
        },
      ],
    });

    const registry = createMinimalRegistry();
    const task = createTitleGenerationTask(store, registry);
    const ctx = {
      store,
      modelInfo: registry.getModel("test:provider"),
      providerRegistry: registry,
      workspaceRoot: "/tmp",
      sessionsDir: TEST_TMP,
    };

    await task.run(ctx as never);

    expect(store.getState().title).toBeNull();
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  test("persists after title generation via saveSessionTranscript", async () => {
    const now = Date.now();
    const store = createSessionStore(crypto.randomUUID());
    const sessionId = store.getState().sessionId;
    store.setState({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              id: crypto.randomUUID(),
              text: "Test message",
              createdAt: now,
              completedAt: now,
            },
          ],
          createdAt: now,
          completedAt: now,
        },
      ],
    });

    const registry = createMinimalRegistry();
    const task = createTitleGenerationTask(store, registry);
    const ctx = {
      store,
      modelInfo: registry.getModel("test:provider"),
      providerRegistry: registry,
      workspaceRoot: "/tmp",
      sessionsDir: TEST_TMP,
    };

    await task.run(ctx as never);

    const filePath = join(TEST_TMP, `${sessionId}.json`);
    const file = Bun.file(filePath);
    expect(await file.exists()).toBe(true);

    const content = JSON.parse(await file.text());
    expect(content.sessionId).toBe(sessionId);
    expect(content.title).toBe("Short test title");
  });
});
