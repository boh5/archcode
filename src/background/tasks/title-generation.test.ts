import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateText } from "ai";
import { createSessionStore } from "../../store/store";
import { __setGenerateTextForTest } from "./title-generation";
import { __setSessionsDirForTest } from "../../store/sessions-dir";

const TEST_TMP = join(import.meta.dir, "__test_tmp__", "title-generation");

const mockGenerateText = mock(
  async () => ({ text: "Short test title" }),
);

import { createTitleGenerationTask } from "./title-generation";
import type { ModelInfo } from "../../provider/model";

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

describe("createTitleGenerationTask", () => {
  beforeEach(async () => {
    __setGenerateTextForTest(mockGenerateText as unknown as typeof generateText);
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(
      async () => ({ text: "Short test title" }),
    );
    await mkdir(TEST_TMP, { recursive: true });
    __setSessionsDirForTest(TEST_TMP);
  });

  afterEach(() => {
    __setGenerateTextForTest(generateText as unknown as typeof generateText);
    __setSessionsDirForTest(undefined);
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

    const task = createTitleGenerationTask(store);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    expect(store.getState().title).toBe("Short test title");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.any(Object),
        prompt: expect.stringContaining("authentication"),
      }),
    );
  });

  test("does nothing when no user message exists", async () => {
    const store = createSessionStore(crypto.randomUUID());
    store.setState({ messages: [] });

    const task = createTitleGenerationTask(store);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    expect(store.getState().title).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("handles generateText failure gracefully", async () => {
    mockGenerateText.mockRejectedValue(new Error("API error"));

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
      const task = createTitleGenerationTask(store);
      const ctx = {
        store,
        modelInfo: makeModelInfo(),
        workspaceRoot: "/tmp",
      };

      await task.run(ctx as never);

      expect(store.getState().title).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "Title generation failed:",
        "API error",
      );
    } finally {
      console.warn = originalWarn;
      mockGenerateText.mockImplementation(
        async () => ({ text: "Short test title" }),
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

    const task = createTitleGenerationTask(store);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
    };

    await task.run(ctx as never);

    expect(store.getState().title).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
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

    const task = createTitleGenerationTask(store);
    const ctx = {
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
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