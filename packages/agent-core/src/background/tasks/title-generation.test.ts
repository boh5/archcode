import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateText } from "ai";
import { storeManager } from "../../store/store";
import { __setGenerateTextForTest } from "./title-generation";
import { __setSessionsDirForTest } from "../../store/sessions-dir";

const TEST_TMP = join(import.meta.dir, "__test_tmp__", "title-generation");

const mockGenerateText = mock(
  async () => ({ text: "Short test title" }),
);

import { createTitleGenerationTask } from "./title-generation";
import type { BackgroundTaskContext } from "../types";
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
    __setSessionsDirForTest(() => TEST_TMP);
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
    const store = storeManager.create(crypto.randomUUID());
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
      modelOptions: {
        temperature: 0.25,
        maxOutputTokens: 32,
        providerOptions: { title: { style: "concise" } },
      },
    };

    await task.run(ctx as never);

    expect(store.getState().title).toBe("Short test title");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.any(Object),
        prompt: expect.stringContaining("authentication"),
        temperature: 0.25,
        maxOutputTokens: 32,
        providerOptions: { title: { style: "concise" } },
      }),
    );
  });

  test("passes all whitelisted model options and strips variant", async () => {
    const now = Date.now();
    const providerOptions = { title: { mode: "full" } };
    const store = storeManager.create(crypto.randomUUID());
    store.setState({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              id: crypto.randomUUID(),
              text: "Summarize this conversation",
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
    await task.run({
      store,
      modelInfo: makeModelInfo(),
      workspaceRoot: "/tmp",
      modelOptions: {
        maxOutputTokens: 64,
        temperature: 0.15,
        topP: 0.5,
        topK: 8,
        presencePenalty: -0.1,
        frequencyPenalty: 0.1,
        stopSequences: ["\n"],
        seed: 11,
        maxRetries: 1,
        timeout: 5000,
        providerOptions,
        variant: "title-fast",
      } as unknown as BackgroundTaskContext["modelOptions"],
    });

    const calls = mockGenerateText.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const callArg = calls[0]![0];
    const pickedOptions = {
      maxOutputTokens: callArg.maxOutputTokens,
      temperature: callArg.temperature,
      topP: callArg.topP,
      topK: callArg.topK,
      presencePenalty: callArg.presencePenalty,
      frequencyPenalty: callArg.frequencyPenalty,
      stopSequences: callArg.stopSequences,
      seed: callArg.seed,
      maxRetries: callArg.maxRetries,
      timeout: callArg.timeout,
      providerOptions: callArg.providerOptions,
    };
    expect(pickedOptions).toEqual({
      maxOutputTokens: 64,
      temperature: 0.15,
      topP: 0.5,
      topK: 8,
      presencePenalty: -0.1,
      frequencyPenalty: 0.1,
      stopSequences: ["\n"],
      seed: 11,
      maxRetries: 1,
      timeout: 5000,
      providerOptions,
    });
    expect(callArg).not.toHaveProperty("variant");
  });

  test("does nothing when no user message exists", async () => {
    const store = storeManager.create(crypto.randomUUID());
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
    const store = storeManager.create(crypto.randomUUID());
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
    const store = storeManager.create(crypto.randomUUID());
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

});
