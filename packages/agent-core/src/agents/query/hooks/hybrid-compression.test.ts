import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StoreApi } from "zustand";
import { setLlmAdapterForTest } from "../../../llm";
import { prepareDynamicRangeCompression } from "../../../compression";
import { storeManager } from "../../../store/store";
import type { SessionStoreState, StoredMessage } from "../../../store/types";
import { silentLogger } from "../../../logger";
import type { BeforeModelBuildContext, BeforeModelCallContext } from "../loop-hooks";
import { createHybridCompressionHook } from "./hybrid-compression";

const generateText = mock(async () => ({ text: "", toolCalls: [{ toolName: "compression_summary", input: summary() }] }));

beforeEach(() => {
  generateText.mockReset();
  generateText.mockImplementation(async () => ({ text: "", toolCalls: [{ toolName: "compression_summary", input: summary() }] }) as never);
  setLlmAdapterForTest({ generateText: generateText as never });
});

function summary(childBlockRefs: string[] = []) {
  return {
    version: 1 as const,
    childBlockRefs,
    sections: {
      "Current Objective": childBlockRefs.length === 0 ? "Continue the current task" : `Continue after (${childBlockRefs[0]})`,
      "User Constraints": "Preserve explicit user constraints",
      "Decisions Made": "Hybrid compression selected a safe prefix",
      "Open Tasks": "Continue from the visible tail",
      "Important Files": "packages/agent-core/src/agents/query/hooks/hybrid-compression.ts",
      "Tool Results": "No critical tool results",
      "Errors/Unknown Results": "None",
      "Protected Refs": "None",
      "Child Block Refs": childBlockRefs.length === 0 ? "None" : childBlockRefs.map((ref) => `(${ref})`).join(" "),
      "Resume Instructions": "Resume from the latest visible message",
    },
  };
}

function makeStore(messageCount = 6): StoreApi<SessionStoreState> {
  const store = storeManager.create(`hybrid-compression-${crypto.randomUUID()}`);
  store.setState({ messages: Array.from({ length: messageCount }, (_, index) => message(index + 1)) });
  return store;
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

function modelInfo(context = 1000): BeforeModelBuildContext["modelInfo"] {
  return {
    model: { modelId: "mock" } as never,
    displayName: "Mock",
    limit: { context, output: 1000 },
    modalities: { input: ["text"], output: ["text"] },
    providerId: "test",
    modelId: "mock",
    qualifiedId: "test:mock",
  } as never;
}

function stepUsage(inputTokens: number) {
  return [{ index: 0, finishReason: "stop", usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 } }] as never;
}

function buildCtx(store: StoreApi<SessionStoreState>, inputTokens: number): BeforeModelBuildContext {
  store.setState({ steps: stepUsage(inputTokens) });
  return { store, modelInfo: modelInfo(), logger: silentLogger };
}

function callCtx(store: StoreApi<SessionStoreState>, inputTokens: number): BeforeModelCallContext {
  store.setState({ steps: stepUsage(inputTokens) });
  return { store, modelInfo: modelInfo(), logger: silentLogger, messages: [] };
}

describe("hybrid compression hooks", () => {
  test("injects no nudge at 54%, soft nudge at exactly 55%, and strong nudge at exactly 70%", async () => {
    const hook = createHybridCompressionHook(silentLogger);

    const below = callCtx(makeStore(), 540);
    await hook.beforeModelCall(below);
    expect(below.messages).toHaveLength(0);

    const soft = callCtx(makeStore(), 550);
    await hook.beforeModelCall(soft);
    expect(JSON.stringify(soft.messages)).toContain("soft nudge");

    const strong = callCtx(makeStore(), 700);
    await hook.beforeModelCall(strong);
    expect(JSON.stringify(strong.messages)).toContain("strong nudge");
  });

  test("commits hard-limit at exactly 85% when a safe range exists", async () => {
    const store = makeStore();
    const hook = createHybridCompressionHook(silentLogger);

    await hook.beforeModelBuild(buildCtx(store, 850));

    expect(store.getState().compression?.activeBlockRefs).toEqual(["b1"]);
    expect(store.getState().compression?.blocksByRef.b1?.strategy).toBe("hard-limit");
    expect(store.getState().compression?.blocksByRef.b1?.trigger).toBe("hard_threshold");
    expect(store.getState().events.at(-1)?.kind).toBe("compression.block_committed");
  });

  test("does not duplicate nudge after hard-limit compression in real hook order", async () => {
    const store = makeStore();
    const hook = createHybridCompressionHook(silentLogger);

    await hook.beforeModelBuild(buildCtx(store, 850));
    const call = callCtx(store, 850);
    await hook.beforeModelCall(call);

    expect(store.getState().compression?.blocksByRef.b1?.strategy).toBe("hard-limit");
    expect(store.getState().events.filter((event) => event.kind === "compression.block_committed")).toHaveLength(1);
    expect(call.messages).toHaveLength(0);
  });

  test("hard-limit safe range preserves latest two complete rounds and current incomplete round", async () => {
    const store = storeManager.create(`hybrid-compression-rounds-${crypto.randomUUID()}`);
    store.setState({ messages: [
      message(1), message(2), message(3), message(4), message(5), message(6),
      message(7), message(8), message(9), message(10),
      { ...message(11), role: "user" },
    ] });
    const hook = createHybridCompressionHook(silentLogger);

    await hook.beforeModelBuild(buildCtx(store, 850));

    expect(store.getState().compression?.blocksByRef.b1?.range).toMatchObject({ startIndex: 0, endIndex: 5 });
  });

  test("commits emergency-hard-limit at exactly 92% when a safe range exists", async () => {
    const store = makeStore();
    const hook = createHybridCompressionHook(silentLogger);

    await hook.beforeModelBuild(buildCtx(store, 920));

    expect(store.getState().compression?.blocksByRef.b1?.strategy).toBe("emergency-hard-limit");
    expect(store.getState().compression?.blocksByRef.b1?.trigger).toBe("emergency_threshold");
  });

  test("does not duplicate nudge after emergency compression in real hook order", async () => {
    const store = makeStore();
    const hook = createHybridCompressionHook(silentLogger);

    await hook.beforeModelBuild(buildCtx(store, 920));
    const call = callCtx(store, 920);
    await hook.beforeModelCall(call);

    expect(store.getState().compression?.blocksByRef.b1?.strategy).toBe("emergency-hard-limit");
    expect(store.getState().events.filter((event) => event.kind === "compression.block_committed")).toHaveLength(1);
    expect(call.messages).toHaveLength(0);
  });

  test("records no_safe_range without activating coverage", async () => {
    const store = makeStore(3);
    const hook = createHybridCompressionHook(silentLogger);

    await hook.beforeModelBuild(buildCtx(store, 850));

    expect(store.getState().compression?.activeBlockRefs).toEqual([]);
    expect(store.getState().compression?.failures.at(-1)?.reason).toContain("no_safe_range");
    expect(store.getState().events.at(-1)?.kind).toBe("compression.block_failed");
    expect(generateText).not.toHaveBeenCalled();
  });

  test("hard-limit safe range rejects partial active-block overlap before summary generation", async () => {
    const store = makeStore(8);
    const child = prepareDynamicRangeCompression(store.getState(), { startId: "m0004", endId: "m0005", summary: summary() }, 1000);
    expect(child.ok).toBe(true);
    if (!child.ok) throw new Error("expected child compression success");
    store.setState({ compression: child.state });
    generateText.mockClear();
    const hook = createHybridCompressionHook(silentLogger);

    await hook.beforeModelBuild(buildCtx(store, 850));

    expect(store.getState().compression?.activeBlockRefs).toEqual(["b1"]);
    expect(store.getState().compression?.failures.at(-1)?.reason).toContain("no_safe_range");
    expect(store.getState().compression?.failures.at(-1)?.reason).toContain("partially overlaps active block");
    expect(generateText).not.toHaveBeenCalled();
  });

  test("hard-limit hysteresis skips automatic compression until five new messages are present", async () => {
    const store = makeStore(8);
    const hook = createHybridCompressionHook(silentLogger);

    await hook.beforeModelBuild(buildCtx(store, 850));
    expect(store.getState().events.filter((event) => event.kind === "compression.block_committed")).toHaveLength(1);
    generateText.mockClear();

    for (let extra = 1; extra <= 4; extra += 1) {
      store.setState({ messages: [...store.getState().messages, message(8 + extra)] });
      await hook.beforeModelBuild(buildCtx(store, 850));
    }

    expect(generateText).not.toHaveBeenCalled();
    expect(store.getState().events.filter((event) => event.kind === "compression.block_committed")).toHaveLength(1);
  });

  test("opens circuit breaker after three hard-limit failures", async () => {
    const store = makeStore(3);
    const hook = createHybridCompressionHook(silentLogger);

    await hook.beforeModelBuild(buildCtx(store, 850));
    await hook.beforeModelBuild(buildCtx(store, 850));
    await hook.beforeModelBuild(buildCtx(store, 850));
    const failureEvents = store.getState().events.filter((event) => event.kind === "compression.block_failed").length;
    await hook.beforeModelBuild(buildCtx(store, 850));

    expect(hook.circuitBreaker.isOpen).toBe(true);
    expect(store.getState().events.filter((event) => event.kind === "compression.block_failed")).toHaveLength(failureEvents);
  });
});
