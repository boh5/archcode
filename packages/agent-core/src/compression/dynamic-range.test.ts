import { describe, expect, test } from "bun:test";
import { createEmptyCompressionState, prepareDynamicRangeCompression, purgeRepeatedOldErrors } from "./index";
import type { CompressionSummary } from "./types";
import type { SessionStoreState, StoredMessage } from "../store/types";
import { createEmptySessionStats } from "@archcode/protocol";

function summary(childBlockRefs: string[] = []): CompressionSummary {
  return {
    childBlockRefs: childBlockRefs as CompressionSummary["childBlockRefs"],
    sections: {
      "Current Objective": childBlockRefs.length > 0 ? "Continue after nested child block" : "Continue task",
      "User Constraints": "Preserve user constraints",
      "Decisions Made": "Dynamic range compression is model-authored",
      "Open Tasks": "Continue implementation",
      "Important Files": "packages/agent-core/src/compression/dynamic-range.ts",
      "Tool Results": "No critical tool output",
      "Errors/Unknown Results": "None",
      "Protected Refs": "None",
      "Child Block Refs": childBlockRefs.length === 0 ? "None" : childBlockRefs.map((ref) => `(${ref})`).join(" "),
      "Resume Instructions": "Resume from the next visible message",
    },
  };
}

function message(id: string, role: StoredMessage["role"], parts: StoredMessage["parts"]): StoredMessage {
  return { id, role, parts, createdAt: 100, completedAt: 101 };
}

function text(id: string, textValue: string): StoredMessage["parts"][number] {
  return { type: "text", id, text: textValue, createdAt: 100, completedAt: 101 };
}

function finalizedResult(preview: string, isError = false, unknownResult = false) {
  const counts = { bytes: new TextEncoder().encode(preview).byteLength, lines: preview.length === 0 ? 0 : preview.split("\n").length };
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
    ...(unknownResult ? { details: { unknownResult: true as const } } : {}),
  };
}

function baseState(messages: StoredMessage[]): SessionStoreState {
  return {
    sessionId: "session-1",
    createdAt: 100,
    updatedAt: 100,
    cwd: "/workspace",
    agentName: "engineer",
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    title: null,
    messages,
    pendingMessages: [],
    inputRequestReceipts: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    compression: createEmptyCompressionState(),
    todos: [],
    reminders: [],
    childSessionLinks: [],
    toolBatches: [],
    rootSessionId: "session-1",
    executionCount: 0,
    isRunning: false,
    isStreamingModel: false,
    lastTodoWriteStepIndex: null,
    lastTodoReminderStepIndex: null,
    todoStepReminderCount: 0,
    todoLoopContinuationCount: 0,
    todoContinuationStagnationCount: 0,
    lastTodoContinuationPendingCount: null,
    lastExtractionIndex: 0,
    lastExtractionTime: 0,
    readSnapshots: new Map(),
    events: [],
    eventOffset: 0,
    nextEventId: 0,
    publishableNextEventId: 0,
    append: () => {},
    setCwd: () => {},
    setTitle: () => {},
    setParentSessionId: () => {},
    toModelMessages: () => [],
  };
}

function fourMessages(): StoredMessage[] {
  return [
    message("msg-1", "user", [text("t1", "one")]),
    message("msg-2", "assistant", [text("t2", "two")]),
    message("msg-3", "user", [text("t3", "three")]),
    message("msg-4", "assistant", [text("t4", "four")]),
    message("msg-5", "user", [text("t5", "five")]),
    message("msg-6", "assistant", [text("t6", "six")]),
  ];
}

describe("dynamic range compression", () => {
  test("valid model-authored range commits an active block without mutating transcript messages", () => {
    const state = baseState(fourMessages());
    const originalMessages = JSON.stringify(state.messages);

    const result = prepareDynamicRangeCompression(state, { startId: "m0001", endId: "m0004", summary: summary() }, 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.block.ref).toBe("b1");
    expect(result.state.activeBlockRefs).toEqual(["b1"]);
    expect(result.event.type).toBe("compression.block_committed");
    expect(JSON.stringify(state.messages)).toBe(originalMessages);
  });

  test("rejects internal message ids and invalid summaries without activating coverage", () => {
    const state = baseState(fourMessages());
    const badRange = prepareDynamicRangeCompression(state, { startId: "msg-1", endId: "m0002", summary: summary() }, 1000);
    const badSummary = prepareDynamicRangeCompression(state, { startId: "m0001", endId: "m0002", summary: { version: 1 } }, 1000);

    expect(badRange.ok).toBe(false);
    expect(badSummary.ok).toBe(false);
    if (badRange.ok || badSummary.ok) throw new Error("expected rejections");
    expect(badRange.state.activeBlockRefs).toEqual([]);
    expect(badSummary.state.activeBlockRefs).toEqual([]);
    expect(badRange.event.type).toBe("compression.block_failed");
  });

  test("rejects single-message tiny ranges before activating coverage", () => {
    const state = baseState(fourMessages());

    const result = prepareDynamicRangeCompression(state, { startId: "m0002", endId: "m0002", summary: summary() }, 1000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("range_rejected");
    expect(result.state.activeBlockRefs).toEqual([]);
    expect(result.event.type).toBe("compression.block_failed");
  });

  test("rejects ranges that include the latest transcript tail", () => {
    const state = baseState(fourMessages());

    const result = prepareDynamicRangeCompression(state, { startId: "m0004", endId: "m0006", summary: summary() }, 1000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("protected_content");
    expect(result.protectedRefs.map((ref) => ref.kind)).toEqual(expect.arrayContaining(["latest_tail"]));
    expect(result.state.activeBlockRefs).toEqual([]);
    expect(result.event.type).toBe("compression.block_failed");
  });

  test("nested parent requires child placeholder exactly once and supersedes the child", () => {
    const state = baseState(fourMessages());
    const child = prepareDynamicRangeCompression(state, { startId: "m0002", endId: "m0003", summary: summary() }, 1000);
    expect(child.ok).toBe(true);
    if (!child.ok) throw new Error("expected child success");

    const parentInputState = { ...state, compression: child.state };
    const parent = prepareDynamicRangeCompression(parentInputState, { startId: "m0001", endId: "m0004", summary: summary(["b1"]) }, 2000);

    expect(parent.ok).toBe(true);
    if (!parent.ok) throw new Error("expected parent success");
    expect(parent.state.blocksByRef.b1?.status).toBe("superseded");
    expect(parent.state.blocksByRef.b2?.status).toBe("active");
    expect(parent.state.blocksByRef.b1?.supersededBy).toBe("b2");
    expect(parent.state.activeBlockRefs).toEqual(["b2"]);
  });

  test("rejects partial active overlap", () => {
    const state = baseState(fourMessages());
    const child = prepareDynamicRangeCompression(state, { startId: "m0002", endId: "m0003", summary: summary() }, 1000);
    expect(child.ok).toBe(true);
    if (!child.ok) throw new Error("expected child success");

    const partial = prepareDynamicRangeCompression({ ...state, compression: child.state }, { startId: "m0003", endId: "m0004", summary: summary() }, 2000);

    expect(partial.ok).toBe(false);
    if (partial.ok) throw new Error("expected rejection");
    expect(partial.code).toBe("invalid_range");
    expect(partial.state.activeBlockRefs).toEqual(["b1"]);
  });

  test("protects pending and running tools, unknown results, protect tags, child links, todos, and reminders", () => {
    const state = baseState([
      message("msg-1", "user", [text("t1", "<protect>keep this</protect>")]),
      message("msg-2", "assistant", [{ type: "tool", id: "tool-pending", state: "pending", toolCallId: "call-pending", toolName: "file_read", createdAt: 1 }]),
      message("msg-3", "assistant", [{ type: "tool", id: "tool-1", state: "running", toolCallId: "call-1", toolName: "bash", input: {}, createdAt: 1, startedAt: 2 }]),
      message("msg-4", "assistant", [{ type: "tool", id: "tool-2", state: "error", toolCallId: "call-2", toolName: "file_write", input: {}, result: finalizedResult("unknown", true, true), createdAt: 1, startedAt: 2, endedAt: 3 }]),
    ]);
    state.todos = [{ id: "todo-1", content: "finish", status: "pending" }];
    state.reminders = [{ id: "r1", source: { type: "todo_step_reminder", pendingTodos: [] }, delivery: "auto_inject", content: "remember", createdAt: 1, consumedAt: null }];
    state.childSessionLinks = [{ parentSessionId: "session-1", parentToolCallId: "call-1", toolName: "delegate", childSessionId: "child", childAgentName: "explore", title: "Explore child", depth: 1, background: false, status: "running", createdAt: 1 }];
    const result = prepareDynamicRangeCompression(state, { startId: "m0001", endId: "m0004", summary: summary() }, 1000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("protected_content");
    expect(result.protectedRefs.map((ref) => ref.kind)).toEqual(expect.arrayContaining([
      "protect_tag",
      "pending_tool",
      "running_tool",
      "unknown_result",
      "subagent_link",
      "todo",
      "reminder",
    ]));
  });

  test("deduplicates repeated completed outputs and purges repeated old errors", () => {
    const state = baseState([
      message("msg-1", "assistant", [{ type: "tool", id: "ok-1", state: "completed", toolCallId: "ok-1", toolName: "grep", input: { pattern: "x" }, result: finalizedResult("same output"), createdAt: 1, startedAt: 2, endedAt: 3 }]),
      message("msg-2", "assistant", [{ type: "tool", id: "ok-2", state: "completed", toolCallId: "ok-2", toolName: "grep", input: { pattern: "x" }, result: finalizedResult("same   output"), createdAt: 1, startedAt: 2, endedAt: 3 }]),
      message("msg-3", "assistant", [{ type: "tool", id: "err-1", state: "error", toolCallId: "err-1", toolName: "bash", input: "bad", result: finalizedResult("failed", true), createdAt: 1, startedAt: 2, endedAt: 3 }]),
      message("msg-4", "assistant", [{ type: "tool", id: "err-2", state: "error", toolCallId: "err-2", toolName: "bash", input: "bad", result: finalizedResult("failed", true), createdAt: 1, startedAt: 2, endedAt: 3 }]),
      message("msg-5", "user", [text("tail-1", "tail one")]),
      message("msg-6", "assistant", [text("tail-2", "tail two")]),
    ]);

    const result = prepareDynamicRangeCompression(state, { startId: "m0001", endId: "m0004", summary: summary() }, 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.deduplicatedToolOutputs[0]?.count).toBe(2);
    expect(result.purgedErrors[0]?.collapsedRefs).toEqual(["m0003"]);
    expect(state.messages[0]?.parts[0]).toMatchObject({ type: "tool", state: "completed", result: { output: { preview: "same output" } } });
  });

  test("purge analysis preserves unknownResult errors instead of collapsing them", () => {
    const messages = [
      message("msg-1", "assistant", [{ type: "tool", id: "err-1", state: "error", toolCallId: "err-1", toolName: "bash", input: "bad", result: finalizedResult("failed", true), createdAt: 1, startedAt: 2, endedAt: 3 }]),
      message("msg-2", "assistant", [{ type: "tool", id: "err-2", state: "error", toolCallId: "err-2", toolName: "bash", input: "bad", result: finalizedResult("failed", true), createdAt: 1, startedAt: 2, endedAt: 3 }]),
      message("msg-3", "assistant", [{ type: "tool", id: "err-unknown", state: "error", toolCallId: "err-unknown", toolName: "bash", input: "bad", result: finalizedResult("failed", true, true), createdAt: 1, startedAt: 2, endedAt: 3 }]),
    ];

    const groups = purgeRepeatedOldErrors(messages, {
      startMessageId: "msg-1",
      endMessageId: "msg-3",
      startRef: "m0001",
      endRef: "m0003",
      startIndex: 0,
      endIndex: 2,
    });

    expect(groups[0]?.collapsedRefs).toEqual(["m0001"]);
    expect(groups[0]?.preservedRefs).toEqual(["m0003", "m0002"]);
    expect(groups[0]?.unknownResultRefs).toEqual(["m0003"]);
  });
});
