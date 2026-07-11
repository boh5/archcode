import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { storeManager } from "../../store/store";
import { createSessionStore } from "../../store/store";
import { SessionStoreManager } from "../../store/session-store-manager";
import { silentLogger } from "../../logger";
import { createMockLogger } from "../../logger.test-helper";
import { setLlmAdapterForTest } from "../../llm";
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

function makeTaskContext(
  store: BackgroundTaskContext["store"],
  overrides: Partial<BackgroundTaskContext> = {},
): BackgroundTaskContext {
  return { store,
  modelInfo: makeModelInfo(),
  logger: silentLogger,
  workspaceRoot: "/tmp", ...overrides,  };
}

async function readPersistedSession(sessionId: string): Promise<Record<string, unknown>> {
  const path = join(TEST_TMP, sessionId, "session.json");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await Bun.file(path).exists()) {
      return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Session file was not persisted for ${sessionId}`);
}

async function waitForPersistedSession(
  sessionId: string,
  predicate: (session: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const session = await readPersistedSession(sessionId);
    if (predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Session file did not reach expected state for ${sessionId}`);
}

describe("createTitleGenerationTask", () => {
  beforeEach(async () => {
    setLlmAdapterForTest({ generateText: mockGenerateText as unknown as typeof import("ai").generateText });
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(
      async () => ({ text: "Short test title" }),
    );
    await mkdir(TEST_TMP, { recursive: true });
    __setSessionsDirForTest(() => TEST_TMP);
  });

  afterEach(() => {
    setLlmAdapterForTest(undefined);
    __setSessionsDirForTest(undefined);
  });

  afterAll(async () => {
    await rm(TEST_TMP, { recursive: true, force: true });
  });

  test("generates title and sets it in store on success", async () => {
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID(), TEST_TMP, { agentName: "engineer" });
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
    const ctx = makeTaskContext(store, {
      modelOptions: {
        temperature: 0.25,
        maxOutputTokens: 32,
        providerOptions: { title: { style: "concise" } },
      },
    });

    await task.run(ctx);

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

  test("generated title persists and survives store reload without external save or flush", async () => {
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const store = createSessionStore(sessionId, import.meta.dir);
    store.setState({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            {
              type: "text",
              id: crypto.randomUUID(),
              text: "Please name this session after deferred event QA",
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
    await task.run(makeTaskContext(store));

    await waitForPersistedSession(sessionId, (session) => session.title === "Short test title");
    const loaded = await new SessionStoreManager({ logger: silentLogger }).getOrLoad(sessionId, "ignored-by-test-override");

    expect(loaded.getState().title).toBe("Short test title");
  });

  test("passes all whitelisted model options and strips variant", async () => {
    const now = Date.now();
    const providerOptions = { title: { mode: "full" } };
    const store = storeManager.create(crypto.randomUUID(), TEST_TMP, { agentName: "engineer" });
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
    await task.run(makeTaskContext(store, {
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
    }));

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
      maxRetries: 0,
      timeout: 5000,
      providerOptions,
    });
    expect(callArg).not.toHaveProperty("variant");
  });

  test("does nothing when no user message exists", async () => {
    const store = storeManager.create(crypto.randomUUID(), TEST_TMP, { agentName: "engineer" });
    store.setState({ messages: [] });

    const task = createTitleGenerationTask(store);
    const ctx = makeTaskContext(store);

    await task.run(ctx);

    expect(store.getState().title).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("handles generateText failure gracefully", async () => {
    mockGenerateText.mockRejectedValue(new Error("API error"));

    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID(), TEST_TMP, { agentName: "engineer" });
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

    const logger = createMockLogger();

    try {
      const task = createTitleGenerationTask(store);
      const ctx = makeTaskContext(store, { logger });

      await task.run(ctx);

      expect(store.getState().title).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith("title.generation.failed", expect.objectContaining({
        error: expect.any(Error),
        context: { sessionId: store.getState().sessionId },
      }));
    } finally {
      mockGenerateText.mockImplementation(
        async () => ({ text: "Short test title" }),
      );
    }
  });

  test("bounded title retry final failure is non-blocking and not chat-visible", async () => {
    mockGenerateText.mockRejectedValue(new Error("provider timeout"));

    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID(), TEST_TMP, { agentName: "engineer" });
    store.setState({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", id: crypto.randomUUID(), text: "Please title this", createdAt: now, completedAt: now }],
          createdAt: now,
          completedAt: now,
        },
      ],
    });
    const logger = createMockLogger();

    await createTitleGenerationTask(store).run(makeTaskContext(store, { logger }));

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    expect(store.getState().title).toBeNull();
    expect(store.getState().messages).toHaveLength(1);
    expect(JSON.stringify(store.getState().messages)).not.toContain("recovery-notice");
    expect(logger.warn).toHaveBeenCalledWith("title.generation.failed", expect.objectContaining({ error: expect.any(Error) }));
  });

  test("does nothing when user message has no text parts", async () => {
    const now = Date.now();
    const store = storeManager.create(crypto.randomUUID(), TEST_TMP, { agentName: "engineer" });
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
    const ctx = makeTaskContext(store);

    await task.run(ctx);

    expect(store.getState().title).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

});
