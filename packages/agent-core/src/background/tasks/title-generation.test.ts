import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionStoreManager } from "../../store/session-store-manager";
import { silentLogger } from "../../logger";
import { createMockLogger } from "../../logger.test-helper";
import { setLlmAdapterForTest } from "../../llm";
import { __setSessionsDirForTest } from "../../store/sessions-dir";
import { createFakeRetryScheduler } from "../../testing/fake-retry-scheduler";
import { createTestModelInfo } from "../../testing/test-execution-fixtures";

const TEST_TMP = join(import.meta.dir, "__test_tmp__", "title-generation", crypto.randomUUID());
const WORKSPACE_ROOT = join(TEST_TMP, "workspace");
const storeManager = new SessionStoreManager({ logger: silentLogger });
const sessionIds = new Set<string>();

const mockGenerateText = mock(
  async () => ({ text: "Short test title" }),
);

import { createTitleGenerationTask } from "./title-generation";
import type { BackgroundTaskContext } from "../types";
import type { ModelInfo } from "../../provider/model";
import type { ExecutionModelBinding } from "../../models";

function createStore(sessionId = crypto.randomUUID()) {
  sessionIds.add(sessionId);
  return storeManager.create(sessionId, WORKSPACE_ROOT, { agentName: "lead" });
}

function makeModelInfo(): ModelInfo {
  return createTestModelInfo();
}

function makeBinding(options?: ExecutionModelBinding["options"]): ExecutionModelBinding {
  const modelInfo = makeModelInfo();
  return { modelInfo, options, summary: {
    selection: { model: modelInfo.qualifiedId }, providerId: modelInfo.providerId, modelId: modelInfo.modelId,
    providerDisplayName: modelInfo.providerDisplayName, modelDisplayName: modelInfo.displayName,
    resolution: "profile_default", modelRuntimeRevision: "test-revision",
  } };
}

function makeTaskContext(
  store: BackgroundTaskContext["store"],
  overrides: Partial<BackgroundTaskContext> = {},
): BackgroundTaskContext {
  return { store,
  binding: makeBinding(),
  logger: silentLogger,
  retryScheduler: createFakeRetryScheduler(),
  workspaceRoot: "/tmp", ...overrides,  };
}

describe("createTitleGenerationTask", () => {
  beforeEach(async () => {
    storeManager.clearAll();
    setLlmAdapterForTest({ generateText: mockGenerateText as unknown as typeof import("ai").generateText });
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(
      async () => ({ text: "Short test title" }),
    );
    await rm(TEST_TMP, { recursive: true, force: true });
    await mkdir(TEST_TMP, { recursive: true });
    __setSessionsDirForTest(() => TEST_TMP);
  });

  afterEach(async () => {
    try {
      await Promise.all([...sessionIds].map((sessionId) => storeManager.flushSession(sessionId, WORKSPACE_ROOT)));
    } finally {
      sessionIds.clear();
      storeManager.clearAll();
      setLlmAdapterForTest(undefined);
      __setSessionsDirForTest(undefined);
    }
  });

  afterAll(async () => {
    __setSessionsDirForTest(undefined);
    await rm(TEST_TMP, { recursive: true, force: true });
  });

  test("generates title and sets it in store on success", async () => {
    const now = Date.now();
    const store = createStore();
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
      binding: makeBinding({
        temperature: 0.25,
        maxOutputTokens: 32,
        providerOptions: { title: { style: "concise" } },
      }),
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

  test("generated title persists and survives store reload", async () => {
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const store = createStore(sessionId);
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

    await storeManager.flushSession(sessionId, WORKSPACE_ROOT);
    const loaded = await new SessionStoreManager({ logger: silentLogger }).getOrLoad(sessionId, WORKSPACE_ROOT);

    expect(loaded.getState().title).toBe("Short test title");
  });

  test("passes all whitelisted model options and strips variant", async () => {
    const now = Date.now();
    const providerOptions = { title: { mode: "full" } };
    const store = createStore();
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
      binding: makeBinding({
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
      } as unknown as ExecutionModelBinding["options"]),
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
    const store = createStore();
    store.setState({ messages: [] });

    const task = createTitleGenerationTask(store);
    const ctx = makeTaskContext(store);

    await task.run(ctx);

    expect(store.getState().title).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("skips command notices and titles the first textual user message", async () => {
    const now = Date.now();
    const store = createStore();
    store.setState({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{
            type: "system-notice",
            id: crypto.randomUUID(),
            notice: "No safe range to compact",
            createdAt: now,
            completedAt: now,
          }],
          createdAt: now,
          completedAt: now,
        },
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{
            type: "text",
            id: crypto.randomUUID(),
            text: "Verify session persistence in the browser",
            createdAt: now,
            completedAt: now,
          }],
          createdAt: now,
          completedAt: now,
        },
      ],
    });

    await createTitleGenerationTask(store).run(makeTaskContext(store));

    expect(store.getState().title).toBe("Short test title");
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("Verify session persistence") }),
    );
  });

  test("handles generateText failure gracefully", async () => {
    mockGenerateText.mockRejectedValue(new Error("API error"));

    const now = Date.now();
    const store = createStore();
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
    const store = createStore();
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
    const retryScheduler = createFakeRetryScheduler();

    await createTitleGenerationTask(store).run(makeTaskContext(store, { logger, retryScheduler }));

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    expect(retryScheduler.sleeps).toHaveLength(2);
    expect(store.getState().title).toBeNull();
    expect(store.getState().messages).toHaveLength(1);
    expect(JSON.stringify(store.getState().messages)).not.toContain("recovery-notice");
    expect(logger.warn).toHaveBeenCalledWith("title.generation.failed", expect.objectContaining({ error: expect.any(Error) }));
  });

  test("does nothing when user message has no text parts", async () => {
    const now = Date.now();
    const store = createStore();
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
