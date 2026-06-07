import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelInfo } from "../provider/model";
import { storeManager } from "../store/store";
import type { StoredMessage } from "../store/types";
import { setLlmAdapterForTest } from "../llm";
import type { CircuitBreaker } from "../compact/circuit-breaker";
import type { ModelCallOptions } from "../config";
import { createCompactCommand } from "./compact";

function makeUserMessage(id: string, text: string): StoredMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", id: `part-${id}`, text, createdAt: Date.now(), completedAt: Date.now() }],
    createdAt: Date.now(),
    completedAt: Date.now(),
  };
}

function makeAssistantMessage(id: string, text: string): StoredMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", id: `part-${id}`, text, createdAt: Date.now(), completedAt: Date.now() }],
    createdAt: Date.now(),
    completedAt: Date.now(),
  };
}

function compactableMessages(): StoredMessage[] {
  return [
    makeUserMessage("u1", "First"),
    makeAssistantMessage("a1", "First response"),
    makeUserMessage("u2", "Second"),
    makeAssistantMessage("a2", "Second response"),
    makeUserMessage("u3", "Third"),
    makeAssistantMessage("a3", "Third response"),
    makeUserMessage("u4", "Fourth"),
    makeAssistantMessage("a4", "Fourth response"),
    makeUserMessage("u5", "Fifth"),
    makeAssistantMessage("a5", "Fifth response"),
    makeUserMessage("u6", "Sixth incomplete"),
  ];
}

const model = { modelId: "mock" } as unknown as LanguageModelV3;
const modelInfo = {
  model,
  displayName: "Mock",
  limit: { context: 100000, output: 1000 },
  modalities: { input: ["text"], output: ["text"] },
  providerId: "test",
  modelId: "mock",
  qualifiedId: "test:mock",
} as unknown as ModelInfo;

function createBreaker(): CircuitBreaker & { reset: ReturnType<typeof mock> } {
  return {
    failureCount: 3,
    isOpen: true,
    recordFailure: mock(() => {}),
    recordSuccess: mock(() => {}),
    reset: mock(() => {}),
  };
}

beforeEach(() => {
  setLlmAdapterForTest({
    streamText: mock(() => ({
      text: Promise.resolve("## Current Objective\nSummarized"),
      fullStream: (async function* () {})(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 1 }),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    })) as unknown as typeof import("ai").streamText,
  });
});

describe("createCompactCommand", () => {
  test("returns compact descriptor", () => {
    const store = storeManager.create(`compact-command-descriptor-${crypto.randomUUID()}`);

    const descriptor = createCompactCommand(store, modelInfo);

    expect(descriptor.name).toBe("compact");
    expect(descriptor.description).toContain("Compact");
  });

  test("triggers compact pipeline and commits result", async () => {
    const store = storeManager.create(`compact-command-success-${crypto.randomUUID()}`);
    store.setState({ messages: compactableMessages() });

    const result = await createCompactCommand(store, modelInfo).handler({ store, modelInfo });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Context compacted. 6 messages summarized. 5 messages preserved in tail.");
    expect(store.getState().messages.some((m) => m.parts.some((p) => p.type === "compaction"))).toBe(true);
  });

  test("passes context modelOptions into compact summary call", async () => {
    let capturedOptions: Record<string, unknown> = {};
    const providerOptions = { openai: { reasoningEffort: "high" } };
    setLlmAdapterForTest({
      streamText: mock((opts: Record<string, unknown>) => {
        capturedOptions = opts;
        return {
          text: Promise.resolve("## Current Objective\nSummarized"),
          fullStream: (async function* () {})(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({ totalTokens: 1 }),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
        };
      }) as unknown as typeof import("ai").streamText,
    });
    const store = storeManager.create(`compact-command-options-${crypto.randomUUID()}`);
    store.setState({ messages: compactableMessages() });

    const result = await createCompactCommand(store, modelInfo).handler({
      store,
      modelInfo,
      modelOptions: {
        temperature: 0.4,
        topP: 0.6,
        maxOutputTokens: 4096,
        providerOptions,
        variant: "large-context",
      } as unknown as ModelCallOptions,
    });

    expect(result.success).toBe(true);
    expect(capturedOptions.temperature).toBe(0.4);
    expect(capturedOptions.topP).toBe(0.6);
    expect(capturedOptions.maxOutputTokens).toBe(4096);
    expect(capturedOptions.providerOptions).toBe(providerOptions);
    expect(capturedOptions).not.toHaveProperty("variant");
  });

  test("bypasses open circuit breaker and resets it on success", async () => {
    const store = storeManager.create(`compact-command-breaker-${crypto.randomUUID()}`);
    const circuitBreaker = createBreaker();
    store.setState({ messages: compactableMessages() });

    const result = await createCompactCommand(store, modelInfo, circuitBreaker).handler({
      store,
      modelInfo,
      circuitBreaker,
    });

    expect(result.success).toBe(true);
    expect(circuitBreaker.reset).toHaveBeenCalledTimes(1);
  });

  test("returns null-result message without resetting circuit breaker", async () => {
    const store = storeManager.create(`compact-command-null-${crypto.randomUUID()}`);
    const circuitBreaker = createBreaker();
    store.setState({ messages: [makeUserMessage("u1", "Only one")] });

    const result = await createCompactCommand(store, modelInfo, circuitBreaker).handler({
      store,
      modelInfo,
      circuitBreaker,
    });

    expect(result).toEqual({ success: false, message: "Not enough messages to compact" });
    expect(circuitBreaker.reset).not.toHaveBeenCalled();
  });

  test("returns busy message while compaction is already in progress", async () => {
    let resolveSummary!: (summary: string) => void;
    setLlmAdapterForTest({
      streamText: mock(() => ({
        text: new Promise<string>((resolve) => {
          resolveSummary = resolve;
        }),
        fullStream: (async function* () {})(),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ totalTokens: 1 }),
        toolCalls: Promise.resolve([]),
        toolResults: Promise.resolve([]),
      })) as unknown as typeof import("ai").streamText,
    });
    const store = storeManager.create(`compact-command-busy-${crypto.randomUUID()}`);
    store.setState({ messages: compactableMessages() });
    const descriptor = createCompactCommand(store, modelInfo);

    const first = descriptor.handler({ store, modelInfo });
    await Promise.resolve();
    const second = await descriptor.handler({ store, modelInfo });
    resolveSummary("## Current Objective\nDone");
    await first;

    expect(second).toEqual({ success: false, message: "Compact already in progress" });
  });

  test("returns failure message and clears busy guard on error", async () => {
    setLlmAdapterForTest({
      streamText: mock(() => {
        throw Object.assign(new Error("model down"), { status: 422 });
      }) as unknown as typeof import("ai").streamText,
    });
    const store = storeManager.create(`compact-command-error-${crypto.randomUUID()}`);
    store.setState({ messages: compactableMessages() });
    const descriptor = createCompactCommand(store, modelInfo);

    const failed = await descriptor.handler({ store, modelInfo });
    const retry = await descriptor.handler({ store, modelInfo });

    expect(failed).toEqual({ success: false, message: "Compact failed: Compact failed: Summary generation failed: compact.summarize failed after 1 attempt: model down" });
    expect(retry.message).not.toBe("Compact already in progress");
  });
});
