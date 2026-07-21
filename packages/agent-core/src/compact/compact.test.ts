import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ExecutionModelBinding } from "../models";
import type { ModelInfo } from "../provider";
import { silentLogger } from "../logger";
import type { StoredMessage } from "../store/types";
import { storeManager } from "../store/store";
import { setLlmAdapterForTest } from "../llm";
import { createFakeRetryScheduler } from "../testing/fake-retry-scheduler";
import { createTestModelInfo } from "../testing/test-execution-fixtures";
import {
  CompactError,
  type CompactInput,
  type CompactResult,
  commitCompact,
  compact,
} from "./compact";

const TEST_WORKSPACE_ROOT = `/tmp/archcode-agent-core-compact-${crypto.randomUUID()}`;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStreamText(respondWith: string) {
  const text = respondWith;
  setLlmAdapterForTest({
    streamText: mock(() => ({
      text: Promise.resolve(text),
      fullStream: (async function* () {
        yield { type: "text-delta", text: text };
      })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ promptTokens: 100, completionTokens: 50 }),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    })) as unknown as typeof import("ai").streamText,
  });
}

function createMockStreamTextThatThrows(error: Error) {
  setLlmAdapterForTest({
    streamText: mock(() => {
      throw error;
    }) as unknown as typeof import("ai").streamText,
  });
}

function createMockStreamTextThatAborts() {
  setLlmAdapterForTest({
    streamText: mock(() => {
      const error = new DOMException("Aborted", "AbortError");
      throw error;
    }) as unknown as typeof import("ai").streamText,
  });
}

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

function makeAssistantMessageWithTool(
  id: string,
  toolCallId: string,
  toolName: string,
  state: "completed" | "error" | "pending" | "running" = "completed",
  output?: string,
): StoredMessage {
  const basePart = {
    type: "tool" as const,
    id: `part-${id}`,
    toolCallId,
    toolName,
    createdAt: Date.now(),
  };

  if (state === "completed") {
    return {
      id,
      role: "assistant",
      parts: [
        {
          ...basePart,
          state: "completed" as const,
          input: {},
          result: finalizedResult(output ?? "tool result", false),
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ],
      createdAt: Date.now(),
      completedAt: Date.now(),
    };
  }

  if (state === "error") {
    return {
      id,
      role: "assistant",
      parts: [
        {
          ...basePart,
          state: "error" as const,
          input: {},
          result: finalizedResult(output ?? "tool error", true),
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ],
      createdAt: Date.now(),
      completedAt: Date.now(),
    };
  }

  if (state === "pending") {
    return {
      id,
      role: "assistant",
      parts: [
        {
          ...basePart,
          state: "pending" as const,
        },
      ],
      createdAt: Date.now(),
    };
  }

  // running
  return {
    id,
    role: "assistant",
    parts: [
      {
        ...basePart,
        state: "running" as const,
        input: {},
        startedAt: Date.now(),
      },
    ],
    createdAt: Date.now(),
  };
}

function finalizedResult(preview: string, isError: boolean) {
  const counts = {
    bytes: new TextEncoder().encode(preview).byteLength,
    lines: preview.length === 0 ? 0 : preview.split("\n").length,
  };
  return {
    isError,
    output: {
      preview,
      completeness: "complete" as const,
      observed: counts,
      canonical: counts,
      stored: counts,
      omitted: { bytes: 0, lines: 0 },
      recovery: { kind: "none" as const },
    },
  };
}

function makeCompactionMessage(id: string, summary: string, tailStartId: string): StoredMessage {
  return {
    id,
    role: "user",
    parts: [
      {
        type: "compaction",
        id: `part-${id}`,
        summary,
        tailStartId,
        compactedAt: Date.now(),
      },
    ],
    createdAt: Date.now(),
    completedAt: Date.now(),
  };
}

const mockModel = { modelId: "test-model" } as unknown as LanguageModelV3;
const mockModelInfo = createTestModelInfo({
  model: mockModel,
  limit: { context: 100000, output: 1000 },
});
const mockBinding: ExecutionModelBinding = {
  modelInfo: mockModelInfo,
  options: undefined,
  summary: {
    selection: { model: mockModelInfo.qualifiedId }, providerId: "test", modelId: "test-model",
    providerDisplayName: "Test Provider", modelDisplayName: "Test Model",
    resolution: "profile_default", modelRuntimeRevision: "test-revision",
  },
};

function makeInput(messages: StoredMessage[], overrides?: Partial<CompactInput>): CompactInput {
  return { messages,
  binding: mockBinding,
  logger: silentLogger,
  retryScheduler: createFakeRetryScheduler(),
  ...overrides,  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compact", () => {
  beforeEach(() => {
    setLlmAdapterForTest(undefined);
  });

  // -------------------------------------------------------------------------
  // Basic compact pipeline
  // -------------------------------------------------------------------------

  test("basic compact: prefix summarized, tail preserved (current incomplete round + last 2 complete rounds)", async () => {
    createMockStreamText("## Current Objective\nTest objective\n## Decisions Made\nNone yet");

    // 5 complete rounds + 1 incomplete round = 6 user messages
    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    const result = await compact(makeInput(messages));

    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Current Objective");
    expect(result!.summary).toContain("Test objective");

    // Tail should start at u4 (last 2 complete rounds: u4+a4, u5+a5, plus incomplete u6)
    expect(result!.tailStartId).toBe("u4");

    // Verify prefix messages are before u4
    const tailIndex = messages.findIndex((m) => m.id === result!.tailStartId);
    expect(tailIndex).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Tool call/result atomicity
  // -------------------------------------------------------------------------

  test("atomic boundary: no split tool call/result pairs in output", async () => {
    createMockStreamText("## Current Objective\nTest");

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessageWithTool("a2", "tc1", "file_read", "completed", "file content here"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message (incomplete)"),
    ];

    const result = await compact(makeInput(messages));

    expect(result).not.toBeNull();
    // Tail starts at u3 (last 2 complete rounds: u3+a3, u4+a4, plus incomplete u5)
    expect(result!.tailStartId).toBe("u3");
  });

  // -------------------------------------------------------------------------
  // Pending/running tools: never compacted
  // -------------------------------------------------------------------------

  test("pending/running tools: boundary moves backward to exclude unsettled tool message", async () => {
    createMockStreamText("## Current Objective\nTest");

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessageWithTool("a3", "tc1", "file_read", "pending"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message (incomplete)"),
    ];

    const result = await compact(makeInput(messages));

    expect(result).not.toBeNull();
    // The boundary should move backward past the pending tool message (a3)
    // to include the entire u3 round in the tail
    expect(result!.tailStartId).toBe("u3");
  });

  // -------------------------------------------------------------------------
  // Transactional commit: if summary fails, store is unchanged
  // -------------------------------------------------------------------------

  test("transactional commit: store unchanged when summary call fails", async () => {
    createMockStreamTextThatThrows(new Error("Model API error"));

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    const store = storeManager.create("test-session-txn", TEST_WORKSPACE_ROOT, { agentName: "lead" });
    const originalMessageCount = store.getState().messages.length;

    let error: CompactError | null = null;
    try {
      await compact(makeInput(messages));
    } catch (e) {
      error = e as CompactError;
    }

    expect(error).not.toBeNull();
    expect(error!.name).toBe("CompactError");
    expect(error!.reason).toContain("Summary generation failed");

    // Store should be unchanged
    expect(store.getState().messages.length).toBe(originalMessageCount);
  });

  // -------------------------------------------------------------------------
  // Current incomplete round: user message without assistant response stays in tail
  // -------------------------------------------------------------------------

  test("current incomplete round: user message without assistant response stays in tail", async () => {
    createMockStreamText("## Current Objective\nIncomplete round test");

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message (incomplete, no response yet)"),
    ];

    const result = await compact(makeInput(messages));

    expect(result).not.toBeNull();
    // Tail = last 2 complete rounds (u2+a2, u3+a3) + incomplete round (u4)
    expect(result!.tailStartId).toBe("u2");
  });

  // -------------------------------------------------------------------------
  // Prefix too short: compact returns null when <5 messages since last compaction
  // -------------------------------------------------------------------------

  test("prefix too short: compact returns null when fewer than 5 messages since last compaction", async () => {
    // Only 3 messages — below COMPACT_MIN_NEW_MESSAGES (5)
    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
    ];

    const result = await compact(makeInput(messages));
    expect(result).toBeNull();
  });

  test("prefix too short: compact returns null when fewer than 5 messages after last compaction", async () => {
    createMockStreamText("## Current Objective\nTest");

    // Compaction message + 3 new messages — below threshold
    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeCompactionMessage("comp1", "Previous summary", "u3"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
    ];

    const result = await compact(makeInput(messages));
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Full tail (no prefix to compact): compact returns null
  // -------------------------------------------------------------------------

  test("full tail: compact returns null when all messages are in the tail", async () => {
    const smallMessages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message (incomplete)"),
    ];

    // Only 5 messages but 2 complete rounds + 1 incomplete = all in tail
    // But we need >= 5 messages for hysteresis. This has 5 messages.
    // However, all are in the tail (2 complete rounds + 1 incomplete).
    // Prefix would be 0 complete rounds = null.
    const result = await compact(makeInput(smallMessages));
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Tool results are already bounded before compaction
  // -------------------------------------------------------------------------

  test("bounded finalized tool results need no second persistence pass", async () => {
    createMockStreamText("## Current Objective\nTest");

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessageWithTool("a1", "tc1", "file_read", "completed", "A".repeat(100)),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    const original = structuredClone(messages);
    const result = await compact(makeInput(messages));

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("prunedToolOutputs");
    expect(messages).toEqual(original);
  });

  // -------------------------------------------------------------------------
  // Abort signal: stops compaction cleanly
  // -------------------------------------------------------------------------

  test("abort signal: stops compaction cleanly", async () => {
    const controller = new AbortController();
    controller.abort();

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    expect(compact(makeInput(messages), controller.signal)).rejects.toThrow();
  });

  test("abort signal during summary: throws AbortError", async () => {
    createMockStreamTextThatAborts();

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    const controller = new AbortController();
    // Don't abort yet — let it reach the summary phase
    // The mock will throw AbortError

    try {
      await compact(makeInput(messages), controller.signal);
      expect.unreachable("Should have thrown");
    } catch (e) {
      // Either CompactError wrapping the abort, or DOMException
      expect(e).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // Summarizer prompt isolation: uses compact-specific prompt, not runtime systemPrompt
  // -------------------------------------------------------------------------

  test("summarizer prompt isolation: compact summary call uses compact-specific minimal system prompt", async () => {
    let capturedSystemPrompt: string | undefined;

    setLlmAdapterForTest({
      streamText: mock((opts: Record<string, unknown>) => {
        capturedSystemPrompt = opts.system as string | undefined;
        return {
          text: Promise.resolve("## Current Objective\nTest objective"),
          fullStream: (async function* () {
            yield { type: "text-delta", text: "## Current Objective\nTest objective" };
          })(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({ promptTokens: 100, completionTokens: 50 }),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
        };
      }) as unknown as typeof import("ai").streamText,
    });

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    await compact(makeInput(messages));

    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).toContain("conversation summarizer");
    expect(capturedSystemPrompt).toContain("Current Objective");
    expect(capturedSystemPrompt).toContain("Tool Output Recovery");
    expect(capturedSystemPrompt).not.toContain("full output saved to");
    // Should NOT contain Memory section text from runtime systemPrompt
    expect(capturedSystemPrompt).not.toContain("## Memory");
  });

  // -------------------------------------------------------------------------
  // CompactError
  // -------------------------------------------------------------------------

  test("CompactError has correct name and message", () => {
    const error = new CompactError("test reason");
    expect(error.name).toBe("CompactError");
    expect(error.message).toBe("Compact failed: test reason");
    expect(error.reason).toBe("test reason");
  });

  test("CompactError preserves cause", () => {
    const cause = new Error("original error");
    const error = new CompactError("wrapped", cause);
    expect(error.cause).toBe(cause);
  });

  // -------------------------------------------------------------------------
  // commitCompact
  // -------------------------------------------------------------------------

  test("commitCompact dispatches compact event to store", () => {
    const store = storeManager.create("test-commit-session", TEST_WORKSPACE_ROOT, { agentName: "lead" });

    // Add some messages first
    const messageId = crypto.randomUUID();
    const executionId = `test-${messageId}`;
    store.getState().append({
      type: "session.messages_committed",
      executionId,
      messages: [{
        id: messageId,
        role: "user",
        parts: [{ type: "text", id: `${messageId}:text`, text: "Hello", createdAt: 1, completedAt: 1 }],
        createdAt: 1,
        completedAt: 1,
        executionId,
        clientRequestId: `request-${messageId}`,
      }],
    });
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "Hi" });
    store.getState().append({ type: "text-end" });

    const result: CompactResult = {
      summary: "Test summary of conversation",
      tailStartId: store.getState().messages[1]!.id,
    };

    commitCompact(store, result);

    const state = store.getState();
    // Should have a compaction message
    const compactionMsg = state.messages.find((m) =>
      m.parts.some((p) => p.type === "compaction"),
    );
    expect(compactionMsg).toBeDefined();

    // The compaction part should have the summary
    const compactionPart = compactionMsg!.parts.find((p) => p.type === "compaction");
    expect(compactionPart).toBeDefined();
    if (compactionPart!.type === "compaction") {
      expect(compactionPart!.summary).toBe("Test summary of conversation");
      expect(compactionPart!.tailStartId).toBe(result.tailStartId);
    }

    // Messages before tailStartId should be marked as compacted
    const tailStartIndex = state.messages.findIndex((m) => m.id === result.tailStartId);
    for (let i = 0; i < tailStartIndex; i++) {
      const msg = state.messages[i]!;
      if (!msg.parts.some((p) => p.type === "compaction")) {
        expect(msg.compacted).toBe(true);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Empty messages
  // -------------------------------------------------------------------------

  test("empty messages: compact returns null", async () => {
    const result = await compact(makeInput([]));
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // All messages in tail (only 2 complete rounds + incomplete)
  // -------------------------------------------------------------------------

  test("all messages in tail when only 2 complete rounds exist: returns null", async () => {
    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message (incomplete)"),
    ];

    const result = await compact(makeInput(messages));
    // Only 2 complete rounds + 1 incomplete = all in tail, no prefix
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Hysteresis with previous compaction
  // -------------------------------------------------------------------------

  test("hysteresis: enough messages after previous compaction proceeds", async () => {
    createMockStreamText("## Current Objective\nTest after compaction");

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeCompactionMessage("comp1", "Previous summary", "u3"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message"),
      makeAssistantMessage("a6", "Sixth response"),
      makeUserMessage("u7", "Seventh message (incomplete)"),
    ];

    // 6 messages after compaction (u3 through u7) >= 5
    const result = await compact(makeInput(messages));
    expect(result).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Deep clone: original messages not mutated
  // -------------------------------------------------------------------------

  test("deep clone: original messages are not mutated during compact", async () => {
    createMockStreamText("## Current Objective\nTest");

    const originalToolOutput = "A".repeat(200);
    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessageWithTool("a1", "tc1", "file_read", "completed", originalToolOutput),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    // Deep clone the messages to compare later
    const originalCopy = structuredClone(messages);

    await compact(makeInput(messages));

    // Original messages should not be mutated
    for (let i = 0; i < messages.length; i++) {
      const original = messages[i]!;
      const copy = originalCopy[i]!;
      expect(original.id).toBe(copy.id);
      expect(original.role).toBe(copy.role);

      for (let j = 0; j < original.parts.length; j++) {
        const origPart = original.parts[j]!;
        const copyPart = copy.parts[j]!;
        if (origPart.type === "tool" && copyPart.type === "tool") {
          if (origPart.state === "completed" && copyPart.state === "completed") {
            expect(origPart.result).toEqual(copyPart.result);
          }
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // Summary contains structured sections
  // -------------------------------------------------------------------------

  test("summary includes structured sections from compact prompt", async () => {
    createMockStreamText("## Current Objective\nBuild a CLI tool\n## Decisions Made\nUse Bun runtime\n## Open Tasks\nImplement compact");

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    const result = await compact(makeInput(messages));

    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Current Objective");
    expect(result!.summary).toContain("Decisions Made");
  });

  // -------------------------------------------------------------------------
  // Error tool parts use their bounded finalized preview
  // -------------------------------------------------------------------------

  test("error tool parts in prefix compact without legacy persistence", async () => {
    createMockStreamText("## Current Objective\nTest");

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessageWithTool("a1", "tc1", "file_read", "error", "Error: file not found"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    const result = await compact(makeInput(messages));

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("prunedToolOutputs");
  });

  // -------------------------------------------------------------------------
  // No tools in summary call
  // -------------------------------------------------------------------------

  test("summary call has no tools (tools denied during summarization)", async () => {
    let capturedOptions: Record<string, unknown> = {};

    setLlmAdapterForTest({
      streamText: mock((opts: Record<string, unknown>) => {
        capturedOptions = opts;
        return {
          text: Promise.resolve("## Current Objective\nTest"),
          fullStream: (async function* () {
            yield { type: "text-delta", text: "## Current Objective\nTest" };
          })(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({ promptTokens: 100, completionTokens: 50 }),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
        };
      }) as unknown as typeof import("ai").streamText,
    });

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    await compact(makeInput(messages));

    // Should NOT have tools property (or it should be empty/undefined)
    expect(capturedOptions.tools).toBeUndefined();
  });

  test("summary call receives configured model call options without variant", async () => {
    let capturedOptions: Record<string, unknown> = {};
    const providerOptions = { openai: { reasoningEffort: "medium" } };

    setLlmAdapterForTest({
      streamText: mock((opts: Record<string, unknown>) => {
        capturedOptions = opts;
        return {
          text: Promise.resolve("## Current Objective\nTest"),
          fullStream: (async function* () {
            yield { type: "text-delta", text: "## Current Objective\nTest" };
          })(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({ promptTokens: 100, completionTokens: 50 }),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
        };
      }) as unknown as typeof import("ai").streamText,
    });

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    await compact(
      makeInput(messages, {
        binding: { ...mockBinding, options: {
          temperature: 0.3,
          topP: 0.7,
          maxOutputTokens: 1024,
          providerOptions,
          variant: "compact-fast",
        } as unknown as ExecutionModelBinding["options"] },
      }),
    );

    expect(capturedOptions.temperature).toBe(0.3);
    expect(capturedOptions.topP).toBe(0.7);
    expect(capturedOptions.maxOutputTokens).toBe(1024);
    expect(capturedOptions.providerOptions).toBe(providerOptions);
    expect(capturedOptions).not.toHaveProperty("variant");
  });

  test("summary call receives every whitelisted model option exactly", async () => {
    let capturedOptions: Record<string, unknown> = {};
    const providerOptions = { compact: { mode: "summary" } };

    setLlmAdapterForTest({
      streamText: mock((opts: Record<string, unknown>) => {
        capturedOptions = opts;
        return {
          text: Promise.resolve("## Current Objective\nTest"),
          fullStream: (async function* () {
            yield { type: "text-delta", text: "## Current Objective\nTest" };
          })(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({ promptTokens: 100, completionTokens: 50 }),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
        };
      }) as unknown as typeof import("ai").streamText,
    });

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    await compact(
      makeInput(messages, {
        binding: { ...mockBinding, options: {
          maxOutputTokens: 2048,
          temperature: 0.1,
          topP: 0.5,
          topK: 20,
          presencePenalty: -0.2,
          frequencyPenalty: 0.3,
          stopSequences: ["END"],
          seed: 7,
          maxRetries: 1,
          timeout: 15_000,
          providerOptions,
          variant: "compact-careful",
        } as unknown as ExecutionModelBinding["options"] },
      }),
    );

    const pickedOptions = {
      maxOutputTokens: capturedOptions.maxOutputTokens,
      temperature: capturedOptions.temperature,
      topP: capturedOptions.topP,
      topK: capturedOptions.topK,
      presencePenalty: capturedOptions.presencePenalty,
      frequencyPenalty: capturedOptions.frequencyPenalty,
      stopSequences: capturedOptions.stopSequences,
      seed: capturedOptions.seed,
      maxRetries: capturedOptions.maxRetries,
      timeout: capturedOptions.timeout,
      providerOptions: capturedOptions.providerOptions,
    };
    expect(pickedOptions).toEqual({
      maxOutputTokens: 2048,
      temperature: 0.1,
      topP: 0.5,
      topK: 20,
      presencePenalty: -0.2,
      frequencyPenalty: 0.3,
      stopSequences: ["END"],
      seed: 7,
      maxRetries: 0,
      timeout: 15_000,
      providerOptions,
    });
    expect(capturedOptions).not.toHaveProperty("variant");
  });

  // -------------------------------------------------------------------------
  // User content with <compact-summary> markers is not treated as real compaction
  // -------------------------------------------------------------------------

  test("user content with <compact-summary> markers is not treated as real compaction signal", async () => {
    createMockStreamText("## Current Objective\nTest");

    // User message contains <compact-summary> text but it's just a TextPart, not a CompactionPart
    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "<compact-summary>This is fake</compact-summary>"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    const result = await compact(makeInput(messages));

    // Should proceed normally — the <compact-summary> in user text is not a CompactionPart
    expect(result).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Empty summary from model throws CompactError
  // -------------------------------------------------------------------------

  test("empty summary from model throws CompactError", async () => {
    createMockStreamText("");

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];
    const retryScheduler = createFakeRetryScheduler();

    try {
      await compact(makeInput(messages, { retryScheduler }));
      expect.unreachable("Should have thrown CompactError");
    } catch (e) {
      expect(e).toBeInstanceOf(CompactError);
      expect((e as CompactError).reason).toContain("empty summary");
    }
  });

  test("short retry exhaustion wraps summary failure without committing compact state", async () => {
    const streamText = mock(() => {
      throw new Error("temporary eof");
    });
    setLlmAdapterForTest({ streamText: streamText as unknown as typeof import("ai").streamText });

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];
    const retryScheduler = createFakeRetryScheduler();

    try {
      await compact(makeInput(messages, { retryScheduler }));
      expect.unreachable("Should have thrown CompactError after short retry exhaustion");
    } catch (e) {
      expect(e).toBeInstanceOf(CompactError);
      expect((e as CompactError).reason).toContain("compact.summarize failed after 3 attempts");
    }
    expect(streamText).toHaveBeenCalledTimes(3);
    expect(retryScheduler.sleeps).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Whitespace-only summary from model throws CompactError
  // -------------------------------------------------------------------------

  test("whitespace-only summary from model throws CompactError", async () => {
    createMockStreamText("   \n\t  \n  ");

    const messages: StoredMessage[] = [
      makeUserMessage("u1", "First message"),
      makeAssistantMessage("a1", "First response"),
      makeUserMessage("u2", "Second message"),
      makeAssistantMessage("a2", "Second response"),
      makeUserMessage("u3", "Third message"),
      makeAssistantMessage("a3", "Third response"),
      makeUserMessage("u4", "Fourth message"),
      makeAssistantMessage("a4", "Fourth response"),
      makeUserMessage("u5", "Fifth message"),
      makeAssistantMessage("a5", "Fifth response"),
      makeUserMessage("u6", "Sixth message (incomplete)"),
    ];

    try {
      await compact(makeInput(messages));
      expect.unreachable("Should have thrown CompactError");
    } catch (e) {
      expect(e).toBeInstanceOf(CompactError);
      expect((e as CompactError).reason).toContain("empty summary");
    }
  });
});
