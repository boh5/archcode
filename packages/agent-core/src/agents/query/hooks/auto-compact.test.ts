import { describe, expect, mock, test, beforeEach } from "bun:test";
import type { StoreApi } from "zustand";
import type { BeforeModelBuildContext } from "../loop-hooks";
import type { SessionStoreState, StoredMessage, StepInfo } from "../../../store/types";
import { createAutoCompactHook } from "./auto-compact";
import { COMPACT_MIN_NEW_MESSAGES } from "../../../compact/token-estimation";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCompact = mock(async (..._args: unknown[]) => null as unknown);
const mockCommitCompact = mock((..._args: unknown[]) => {});

mock.module("../../../compact/compact", () => ({
  compact: (input: unknown, abort?: AbortSignal) => mockCompact(input, abort),
  commitCompact: (store: unknown, result: unknown) => mockCommitCompact(store, result),
  CompactError: class CompactError extends Error {
    constructor(public readonly reason: string, public readonly cause?: unknown) {
      super(`Compact failed: ${reason}`);
      this.name = "CompactError";
    }
  },
}));

mock.module("../../../compact/circuit-breaker", () => ({
  createCircuitBreaker: (maxFailures: number = 3) => {
    let _failureCount = 0;
    return {
      get failureCount() { return _failureCount; },
      get isOpen() { return _failureCount >= maxFailures; },
      recordFailure() { _failureCount++; },
      recordSuccess() { _failureCount = 0; },
      reset() { _failureCount = 0; },
    };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTEXT_LIMIT = 100_000;

function createMockStore(overrides: Partial<SessionStoreState> = {}): StoreApi<SessionStoreState> {
  const messages: StoredMessage[] = [];
  const steps: StepInfo[] = [];

  const state: SessionStoreState = {
    sessionId: "test-session",
    createdAt: Date.now(),
    title: null,
    messages,
    steps,
    todos: [],
    reminders: [],
    childSessionIds: new Set(),
    subAgentDescriptions: new Map(),
    runCount: 0,
    lastTodoWriteStepIndex: null,
    lastTodoReminderStepIndex: null,
    todoStepReminderCount: 0,
    todoLoopContinuationCount: 0,
    todoContinuationStagnationCount: 0,
    lastTodoContinuationPendingCount: null,
    lastExtractionIndex: 0,
    lastExtractionTime: 0,
    isRunning: false,
    isStreamingModel: false,
    readSnapshots: new Map(),
    events: [],
    eventOffset: 0,
    nextEventId: 0,
    append: mock(() => {}),
    setTitle: mock(() => {}),
    setParentSessionId: mock(() => {}),
    linkChildSession: mock(() => {}),
    toModelMessages: mock(() => []),
    ...overrides,
  };

  let _state = state;
  return {
    getState: () => _state,
    setState: (partial: Partial<SessionStoreState> | ((s: SessionStoreState) => Partial<SessionStoreState>)) => {
      const update = typeof partial === "function" ? partial(_state) : partial;
      _state = { ..._state, ...update };
    },
    subscribe: () => () => {},
    getInitialState: () => state,
  } as StoreApi<SessionStoreState>;
}

function createMockModelInfo(contextLimit: number = CONTEXT_LIMIT) {
  return {
    model: { modelId: "test-model" } as never,
    displayName: "Test Model",
    limit: { context: contextLimit, output: 4096 },
    modalities: { input: ["text"], output: ["text"] },
    providerId: "test",
    modelId: "test-model",
    qualifiedId: "test:test-model",
  };
}

function createContext(overrides: Partial<BeforeModelBuildContext> = {}): BeforeModelBuildContext {
  return {
    store: createMockStore(),
    modelInfo: createMockModelInfo() as never,
    ...overrides,
  };
}

function makeStoredMessage(parts: StoredMessage["parts"] = []): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts,
    createdAt: Date.now(),
  };
}

function makeCompactionPart(): { type: "compaction"; id: string; summary: string; tailStartId: string; compactedAt: number } {
  return {
    type: "compaction",
    id: crypto.randomUUID(),
    summary: "Previous compaction summary",
    tailStartId: "tail-id",
    compactedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAutoCompactHook", () => {
  beforeEach(() => {
    mockCompact.mockClear();
    mockCommitCompact.mockClear();
  });

  test("returns hook function and circuitBreaker", () => {
    const result = createAutoCompactHook();
    expect(typeof result.hook).toBe("function");
    expect(result.circuitBreaker).toBeDefined();
    expect(typeof result.circuitBreaker.isOpen).toBe("boolean");
    expect(typeof result.circuitBreaker.recordFailure).toBe("function");
    expect(typeof result.circuitBreaker.recordSuccess).toBe("function");
    expect(typeof result.circuitBreaker.reset).toBe("function");
  });

  test("does NOT trigger compact when below threshold", async () => {
    const result = createAutoCompactHook();
    // toModelMessages returns empty → estimatedTokens = 0, no steps → usageTokens = 0
    const ctx = createContext();
    await result.hook(ctx);
    expect(mockCompact).not.toHaveBeenCalled();
  });

  test("triggers compact when above 75% threshold via usage", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(1);
    expect(mockCommitCompact).toHaveBeenCalledTimes(1);
  });

  test("triggers compact when above 75% threshold via estimation fallback", async () => {
    const result = createAutoCompactHook();
    // No steps → no usage. toModelMessages returns large content → estimated > 75%
    const largeContent = "x".repeat(CONTEXT_LIMIT * 4 * 0.76); // chars/4 heuristic
    const store = createMockStore({
      steps: [],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [{ role: "user" as const, content: largeContent }],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(1);
  });

  test("uses Math.max of usage and estimated tokens", async () => {
    const result = createAutoCompactHook();
    // usage says 80k (above 75%), estimation says 10k (below) → should still trigger
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [{ role: "user" as const, content: "short" }],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(1);
  });

  test("uses systemPrompt in fallback estimation", async () => {
    const result = createAutoCompactHook();
    // No usage, short messages, but large systemPrompt pushes over threshold
    const largeSystemPrompt = "y".repeat(CONTEXT_LIMIT * 4 * 0.76);
    const store = createMockStore({
      steps: [],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [{ role: "user" as const, content: "short" }],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    const ctx = createContext({
      store,
      modelInfo: createMockModelInfo() as never,
      systemPrompt: largeSystemPrompt,
    });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(1);
  });

  test("isCompacting guard prevents recursive compact", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    // Make compact hang so isCompacting stays true
    let resolveCompact: (value: unknown) => void;
    mockCompact.mockReturnValueOnce(new Promise((r) => { resolveCompact = r; }));

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });

    // Start first compact (don't await)
    const firstCall = result.hook(ctx);

    // Try second call while first is running
    await result.hook(ctx);

    // Only one compact call should have been made
    expect(mockCompact).toHaveBeenCalledTimes(1);

    // Resolve the hanging compact
    resolveCompact!(null);
    await firstCall;
  });

  test("isCompacting is reset in finally block on success", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    // Should be able to trigger again (isCompacting was reset)
    mockCompact.mockResolvedValueOnce({
      summary: "Compacted again",
      tailStartId: "tail-id-2",
      prunedToolOutputs: [],
    });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(2);
  });

  test("isCompacting is reset in finally block on failure", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    mockCompact.mockRejectedValueOnce(new Error("LLM failed"));

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx); // Should not throw

    // isCompacting should be reset, so next call should attempt compact again
    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(2);
  });

  test("hysteresis: skips if fewer than COMPACT_MIN_NEW_MESSAGES since last compaction", async () => {
    const result = createAutoCompactHook();
    const compactionPart = makeCompactionPart();
    const messages: StoredMessage[] = [
      makeStoredMessage(), // before compaction
      makeStoredMessage([compactionPart]), // compaction message
      makeStoredMessage(), // 1 message after
      makeStoredMessage(), // 2 messages after
      makeStoredMessage(), // 3 messages after
    ];

    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages,
      toModelMessages: () => [],
    });

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(mockCompact).not.toHaveBeenCalled();
  });

  test("hysteresis: triggers when enough new messages since last compaction", async () => {
    const result = createAutoCompactHook();
    const compactionPart = makeCompactionPart();
    const messages: StoredMessage[] = [
      makeStoredMessage(),
      makeStoredMessage([compactionPart]),
      ...Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
    ];

    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages,
      toModelMessages: () => [],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(1);
  });

  test("hysteresis: no compaction part — uses total message count", async () => {
    const result = createAutoCompactHook();
    // Only 3 messages, no compaction part → below COMPACT_MIN_NEW_MESSAGES
    const messages: StoredMessage[] = [
      makeStoredMessage(),
      makeStoredMessage(),
      makeStoredMessage(),
    ];

    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages,
      toModelMessages: () => [],
    });

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(mockCompact).not.toHaveBeenCalled();
  });

  test("circuit breaker open skips compact", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    // Trip the circuit breaker
    result.circuitBreaker.recordFailure();
    result.circuitBreaker.recordFailure();
    result.circuitBreaker.recordFailure();
    expect(result.circuitBreaker.isOpen).toBe(true);

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(mockCompact).not.toHaveBeenCalled();
  });

  test("circuit breaker recordFailure on compact error", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    mockCompact.mockRejectedValueOnce(new Error("LLM error"));

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(result.circuitBreaker.failureCount).toBe(1);
    expect(mockCommitCompact).not.toHaveBeenCalled();
  });

  test("circuit breaker recordSuccess on compact success", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    // Trip breaker partially first
    result.circuitBreaker.recordFailure();
    result.circuitBreaker.recordFailure();
    expect(result.circuitBreaker.failureCount).toBe(2);

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(result.circuitBreaker.failureCount).toBe(0);
    expect(mockCommitCompact).toHaveBeenCalledTimes(1);
  });

  test("re-throws AbortError from compact", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    const abortError = new DOMException("Aborted", "AbortError");
    mockCompact.mockRejectedValueOnce(abortError);

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await expect(result.hook(ctx)).rejects.toThrow("Aborted");
  });

  test("isCompacting reset in finally block after AbortError", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    const abortError = new DOMException("Aborted", "AbortError");
    mockCompact.mockRejectedValueOnce(abortError);

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    try { await result.hook(ctx); } catch { /* expected */ }

    // isCompacting should be reset — next call should attempt compact
    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(2);
  });

  test("uses modelInfo.limit.context for threshold calculation", async () => {
    const result = createAutoCompactHook();
    const smallContextLimit = 10_000;
    // 80k tokens > 75% of 10k → should trigger
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 8_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    const ctx = createContext({ store, modelInfo: createMockModelInfo(smallContextLimit) as never });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(1);
  });

  test("compact returns null — does not call commitCompact", async () => {
    const result = createAutoCompactHook();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    mockCompact.mockResolvedValueOnce(null);

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(1);
    expect(mockCommitCompact).not.toHaveBeenCalled();
  });

  test("passes correct input to compact", async () => {
    const result = createAutoCompactHook();
    const messages = Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage());
    const modelInfo = createMockModelInfo();
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { promptTokens: 80_000 } }],
      messages,
      toModelMessages: () => [],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    const abort = new AbortController().signal;
    const modelOptions = { temperature: 0.2, maxOutputTokens: 2048 };
    const ctx = createContext({ store, modelInfo: modelInfo as never, abort, modelOptions });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(1);
    const call = mockCompact.mock.calls[0] as [
      { messages: StoredMessage[]; contextLimit: number; model: unknown; sessionId: string; modelOptions: unknown },
      AbortSignal | undefined,
    ];
    expect(call[0].messages).toBe(messages);
    expect(call[0].contextLimit).toBe(CONTEXT_LIMIT);
    expect(call[0].model).toBe(modelInfo.model);
    expect(call[0].sessionId).toBe("test-session");
    expect(call[0].modelOptions).toBe(modelOptions);
    expect(call[1]).toBe(abort);
  });

  test("circuitBreaker.reset() works for /compact command integration", () => {
    const result = createAutoCompactHook();
    result.circuitBreaker.recordFailure();
    result.circuitBreaker.recordFailure();
    result.circuitBreaker.recordFailure();
    expect(result.circuitBreaker.isOpen).toBe(true);

    result.circuitBreaker.reset();
    expect(result.circuitBreaker.isOpen).toBe(false);
    expect(result.circuitBreaker.failureCount).toBe(0);
  });

  test("parseStepUsage used for token count — not direct .promptTokens access", async () => {
    const result = createAutoCompactHook();
    // OpenAI-style usage with prompt_tokens instead of promptTokens
    const store = createMockStore({
      steps: [{ id: "step-1", step: 1, startedAt: Date.now(), usage: { prompt_tokens: 80_000 } }],
      messages: Array.from({ length: COMPACT_MIN_NEW_MESSAGES }, () => makeStoredMessage()),
      toModelMessages: () => [],
    });

    mockCompact.mockResolvedValueOnce({
      summary: "Compacted",
      tailStartId: "tail-id",
      prunedToolOutputs: [],
    });

    const ctx = createContext({ store, modelInfo: createMockModelInfo() as never });
    await result.hook(ctx);

    expect(mockCompact).toHaveBeenCalledTimes(1);
  });
});
