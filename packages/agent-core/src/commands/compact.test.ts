import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CompressionBlockSnapshot } from "@archcode/protocol";
import type { ModelInfo } from "../provider/model";
import { storeManager } from "../store/store";
import type { CompactionPart, StoredMessage } from "../store/types";
import { setLlmAdapterForTest } from "../llm";
import type { CircuitBreaker } from "../compact/circuit-breaker";
import type { ModelCallOptions } from "../config";
import { SkillService } from "../skills";
import { createCompactCommand } from "./compact";
import type { CommandContext } from "./types";

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

function compressionBlockSnapshot(): CompressionBlockSnapshot {
  return {
    id: "block-1",
    ref: "b1",
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    range: { startMessageId: "u1", endMessageId: "a1", startRef: "m0001", endRef: "m0002", startIndex: 0, endIndex: 1 },
    summary: "## Current Objective\nKeep going",
    childBlockRefs: [],
    protectedRefs: [],
    createdAt: 123456789,
    updatedAt: 123456789,
  };
}

const model = { modelId: "mock" } as unknown as ModelInfo["model"];
const modelInfo = {
  model,
  displayName: "Mock",
  limit: { context: 100000, output: 1000 },
  modalities: { input: ["text"], output: ["text"] },
          capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
  providerId: "test",
  modelId: "mock",
  qualifiedId: "test:mock",
} as unknown as ModelInfo;
const skillService = new SkillService({ builtinSkills: {} });
const TEST_WORKSPACE_ROOT = `/tmp/archcode-agent-core-compact-command-${crypto.randomUUID()}`;

function commandContext(
  store: CommandContext["store"],
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    store,
    modelInfo,
    cwd: import.meta.dir,
    agentName: "engineer",
    agentSkills: [],
    skillService,
    ...overrides,
  };
}

function summary() {
  return {
    childBlockRefs: [],
    sections: {
      "Current Objective": "Continue the current task",
      "User Constraints": "Preserve constraints",
      "Decisions Made": "Manual hard compact selected a safe prefix",
      "Open Tasks": "Continue from the visible tail",
      "Important Files": "packages/agent-core/src/commands/compact.ts",
      "Tool Results": "None",
      "Errors/Unknown Results": "None",
      "Protected Refs": "None",
      "Child Block Refs": "None",
      "Resume Instructions": "Resume after the block",
    },
  };
}

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
    generateText: mock(() => ({
      text: "",
      toolCalls: [{ toolName: "compression_summary", input: summary() }],
    })) as unknown as typeof import("ai").generateText,
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
    const store = storeManager.create(`compact-command-descriptor-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });

    const descriptor = createCompactCommand(store, modelInfo);

    expect(descriptor.name).toBe("compact");
    expect(descriptor.description).toContain("Compact");
  });

  test("manual compact emits compact event and compaction part without compression block", async () => {
    const store = storeManager.create(`compact-command-success-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });
    store.setState({ messages: compactableMessages() });

    const result = await createCompactCommand(store, modelInfo).handler(commandContext(store));

    expect(result.success).toBe(true);
    expect(result.message).toBe("Context compacted. 6 messages summarized. 5 messages preserved in tail.");
    expect(store.getState().events.at(-1)?.payload.type).toBe("compact");
    expect(store.getState().events.some((event) => event.payload.type === "compression.block_committed")).toBe(false);
    expect(store.getState().messages.slice(0, 6).every((message) => message.compacted === true)).toBe(true);
    const compactionMessage = store.getState().messages.find((message) => message.parts.some((part) => part.type === "compaction"));
    const compactionPart = compactionMessage?.parts.find((part) => part.type === "compaction") as CompactionPart | undefined;
    expect(compactionPart?.tailStartId).toBe("u4");
    expect(compactionPart?.summary).toContain("Current Objective");
  });

  test("manual compact clears existing dynamic compression state", async () => {
    const store = storeManager.create(`compact-command-clear-dynamic-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });
    store.setState({ messages: compactableMessages() });
    store.getState().append({ type: "compression.block_committed", block: compressionBlockSnapshot() });

    expect(store.getState().compression?.activeBlockRefs).toEqual(["b1"]);

    const result = await createCompactCommand(store, modelInfo).handler(commandContext(store));

    expect(result.success).toBe(true);
    expect(store.getState().compression?.activeBlockRefs).toEqual([]);
    expect(store.getState().compression?.blocksByRef).toEqual({});
    expect(JSON.stringify(store.getState().toModelMessages())).not.toContain("compression-block");
    expect(JSON.stringify(store.getState().toModelMessages())).toContain("compact-summary");
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
    const store = storeManager.create(`compact-command-options-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });
    store.setState({ messages: compactableMessages() });

    const result = await createCompactCommand(store, modelInfo).handler(commandContext(store, {
      modelOptions: {
        temperature: 0.4,
        topP: 0.6,
        maxOutputTokens: 4096,
        providerOptions,
        variant: "large-context",
      } as unknown as ModelCallOptions,
    }));

    expect(result.success).toBe(true);
    expect(capturedOptions.temperature).toBe(0.4);
    expect(capturedOptions.topP).toBe(0.6);
    expect(capturedOptions.maxOutputTokens).toBe(4096);
    expect(capturedOptions.providerOptions).toBe(providerOptions);
    expect(capturedOptions).not.toHaveProperty("variant");
  });

  test("bypasses open circuit breaker and resets it on success", async () => {
    const store = storeManager.create(`compact-command-breaker-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });
    const circuitBreaker = createBreaker();
    store.setState({ messages: compactableMessages() });

    const result = await createCompactCommand(store, modelInfo, circuitBreaker).handler(commandContext(store, {
      circuitBreaker,
    }));

    expect(result.success).toBe(true);
    expect(circuitBreaker.reset).toHaveBeenCalledTimes(1);
  });

  test("returns null-result message without resetting circuit breaker", async () => {
    const store = storeManager.create(`compact-command-null-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });
    const circuitBreaker = createBreaker();
    store.setState({ messages: [makeUserMessage("u1", "Only one")] });

    const result = await createCompactCommand(store, modelInfo, circuitBreaker).handler(commandContext(store, {
      circuitBreaker,
    }));

    expect(result).toEqual({ success: false, message: "No safe range to compact" });
    expect(circuitBreaker.reset).not.toHaveBeenCalled();
  });

  test("returns busy message while compaction is already in progress", async () => {
    let resolveSummary!: (summary: string) => void;
    setLlmAdapterForTest({
      streamText: mock(() => ({
        text: new Promise((resolve) => {
          resolveSummary = resolve;
        }),
        fullStream: (async function* () {})(),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ totalTokens: 1 }),
        toolCalls: Promise.resolve([]),
        toolResults: Promise.resolve([]),
      })) as unknown as typeof import("ai").streamText,
    });
    const store = storeManager.create(`compact-command-busy-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });
    store.setState({ messages: compactableMessages() });
    const descriptor = createCompactCommand(store, modelInfo);

    const first = descriptor.handler(commandContext(store));
    await Promise.resolve();
    const second = await descriptor.handler(commandContext(store));
    resolveSummary("done");
    await first;

    expect(second).toEqual({ success: false, message: "Compact already in progress" });
  });

  test("returns failure message and clears busy guard on error", async () => {
    setLlmAdapterForTest({
      streamText: mock(() => {
        throw Object.assign(new Error("model down"), { status: 422 });
      }) as unknown as typeof import("ai").streamText,
    });
    const store = storeManager.create(`compact-command-error-${crypto.randomUUID()}`, TEST_WORKSPACE_ROOT, { agentName: "engineer" });
    store.setState({ messages: compactableMessages() });
    const descriptor = createCompactCommand(store, modelInfo);

    const failed = await descriptor.handler(commandContext(store));
    const retry = await descriptor.handler(commandContext(store));

    expect(failed.message).toContain("Compact failed:");
    expect(failed.message).toContain("model down");
    expect(retry.message).not.toBe("Compact already in progress");
  });
});
