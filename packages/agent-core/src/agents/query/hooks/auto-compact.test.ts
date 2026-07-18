import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setLlmAdapterForTest } from "../../../llm";
import { silentLogger } from "../../../logger";
import { storeManager } from "../../../store/store";
import type { StoredMessage } from "../../../store/types";
import type { BeforeModelBuildContext } from "../loop-hooks";
import { createAutoCompactHook } from "./auto-compact";

const TEST_WORKSPACE_ROOT = `/tmp/archcode-agent-core-auto-compact-${crypto.randomUUID()}`;

const generateText = mock(async () => ({ text: "", toolCalls: [{ toolName: "compression_summary", input: summary() }] }));
const streamText = mock(() => ({
  text: Promise.resolve("## Current Objective\nContinue the current task"),
  fullStream: (async function* () {})(),
  finishReason: Promise.resolve("stop"),
  usage: Promise.resolve({ totalTokens: 1 }),
  toolCalls: Promise.resolve([]),
  toolResults: Promise.resolve([]),
}));

beforeEach(() => {
  generateText.mockReset();
  streamText.mockReset();
  generateText.mockImplementation(async () => ({ text: "", toolCalls: [{ toolName: "compression_summary", input: summary() }] }) as never);
  streamText.mockImplementation(() => ({
    text: Promise.resolve("## Current Objective\nContinue the current task"),
    fullStream: (async function* () {})(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ totalTokens: 1 }),
    toolCalls: Promise.resolve([]),
    toolResults: Promise.resolve([]),
  }) as never);
  setLlmAdapterForTest({ generateText: generateText as never, streamText: streamText as never });
});

function summary() {
  return {
    childBlockRefs: [],
    sections: {
      "Current Objective": "Continue the current task",
      "User Constraints": "Preserve explicit user constraints",
      "Decisions Made": "Hybrid compression selected a safe prefix",
      "Open Tasks": "Continue from the visible tail",
      "Important Files": "packages/agent-core/src/agents/query/hooks/auto-compact.ts",
      "Tool Results": "No critical tool results",
      "Errors/Unknown Results": "None",
      "Protected Refs": "None",
      "Child Block Refs": "None",
      "Resume Instructions": "Resume from the latest visible message",
    },
  };
}

function message(index: number): StoredMessage {
  return {
    id: `msg-${index}`,
    role: index % 2 === 1 ? "user" : "assistant",
    parts: [{ type: "text", id: `text-${index}`, text: `message ${index}`, createdAt: 1, completedAt: 2 }],
    createdAt: 1,
    completedAt: 2,
  };
}

function createStore(messageCount = 6) {
  const store = storeManager.create(`auto-compact-wrapper-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });
  store.setState({ messages: Array.from({ length: messageCount }, (_, index) => message(index + 1)) });
  return store;
}

function modelInfo(context = 1000): BeforeModelBuildContext["modelInfo"] {
  return {
    model: { modelId: "mock" } as never,
    displayName: "Mock",
    limit: { context, output: 1000 },
    modalities: { input: ["text"], output: ["text"] },
          capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
    providerId: "test",
    modelId: "mock",
    qualifiedId: "test:mock",
  } as never;
}

function buildCtx(store: ReturnType<typeof createStore>, inputTokens: number): BeforeModelBuildContext {
  store.setState({ steps: [{ id: "step-1", step: 1, startedAt: 1, usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 } }] });
  return { store, modelInfo: modelInfo(), logger: silentLogger };
}

describe("createAutoCompactHook", () => {
  test("returns the hook function and circuit breaker", () => {
    const result = createAutoCompactHook(silentLogger);

    expect(typeof result.hook).toBe("function");
    expect(result.circuitBreaker).toBeDefined();
    expect(typeof result.circuitBreaker.isOpen).toBe("boolean");
    expect(typeof result.circuitBreaker.recordFailure).toBe("function");
    expect(typeof result.circuitBreaker.recordSuccess).toBe("function");
    expect(typeof result.circuitBreaker.reset).toBe("function");
  });

  test("delegates automatic high-threshold compaction to forced hard compact", async () => {
    const store = createStore();
    const result = createAutoCompactHook(silentLogger);

    await result.hook(buildCtx(store, 850));

    expect(store.getState().events.at(-1)?.payload.type).toBe("compact");
    expect(store.getState().events.some((event) => event.payload.type === "compression.block_committed")).toBe(false);
    expect(store.getState().messages.some((storedMessage) => storedMessage.parts.some((part) => part.type === "compaction"))).toBe(true);
    expect(store.getState().messages.slice(0, 2).every((storedMessage) => storedMessage.compacted === true)).toBe(true);
  });

  test("keeps circuitBreaker.reset available for manual command integration", () => {
    const result = createAutoCompactHook(silentLogger);
    result.circuitBreaker.recordFailure();
    result.circuitBreaker.recordFailure();
    result.circuitBreaker.recordFailure();
    expect(result.circuitBreaker.isOpen).toBe(true);

    result.circuitBreaker.reset();

    expect(result.circuitBreaker.isOpen).toBe(false);
    expect(result.circuitBreaker.failureCount).toBe(0);
  });
});
