import { describe, expect, test } from "bun:test";
import {
  createEmptySessionStats,
  type AssistantSessionPart,
  type UserSessionPart,
} from "@archcode/protocol";
import { createEmptyCompressionState, prepareDynamicRangeCompression } from "./index";
import { resolveCompressionOriginalRange } from "./original-range";
import type { BlockRef, CompressionSummaryTemplate } from "./types";
import type { SessionFile } from "../store/helpers";
import type { SessionStoreState, StoredMessage } from "../store/types";

function finalizedResult(
  preview: string,
  recovery: { kind: "none" } | { kind: "artifact"; outputRef: string; expiresAt: number; canRead: true; canSearch: true } = { kind: "none" },
) {
  const counts = { bytes: new TextEncoder().encode(preview).byteLength, lines: preview.length === 0 ? 0 : preview.split("\n").length };
  return {
    isError: false,
    output: {
      preview,
      completeness: recovery.kind === "none" ? "complete" as const : "partial" as const,
      observed: counts,
      canonical: counts,
      stored: counts,
      omitted: { bytes: 0, lines: 0 },
      recovery,
    },
  };
}

function summary(childBlockRefs: BlockRef[] = []): CompressionSummaryTemplate {
  return {
    sections: {
      "Current Objective": childBlockRefs.length > 0 ? "Continue task after child blocks" : "Continue task",
      "User Constraints": "Preserve constraints",
      "Decisions Made": "Use DCP-like dynamic compression coverage",
      "Open Tasks": "Expose originals lazily",
      "Important Files": "packages/agent-core/src/compression/original-range.ts",
      "Tool Results": "Small outputs can be returned inline",
      "Errors/Unknown Results": "None",
      "Protected Refs": "None",
      "Child Block Refs": childBlockRefs.length === 0 ? "None" : childBlockRefs.map((ref) => `(${ref})`).join(" "),
      "Resume Instructions": "Resume from the visible tail",
    },
  };
}

function text(id: string, value: string): UserSessionPart {
  return { type: "text", id, text: value, createdAt: 100, completedAt: 101 };
}

function output(id: string, value: string): AssistantSessionPart {
  return {
    type: "assistant-output",
    id,
    blockId: `block:${id}`,
    text: value,
    createdAt: 100,
    completedAt: 101,
  };
}

function message(id: string, role: "user", parts: UserSessionPart[]): StoredMessage;
function message(id: string, role: "assistant", parts: AssistantSessionPart[]): StoredMessage;
function message(
  id: string,
  role: StoredMessage["role"],
  parts: UserSessionPart[] | AssistantSessionPart[],
): StoredMessage {
  if (role === "user") {
    return {
      id,
      role,
      parts: parts as UserSessionPart[],
      createdAt: 100,
      completedAt: 101,
    };
  }
  return {
    id,
    role,
    parts: parts as AssistantSessionPart[],
    executionId: `execution:${id}`,
    runOrdinal: 0,
    stepId: `step:${id}`,
    outputPhase: "commentary",
    createdAt: 100,
    completedAt: 101,
  };
}

function messagesWithTools(): StoredMessage[] {
  return [
    message("msg-1", "user", [text("t1", "one")]),
    message("msg-2", "assistant", [{
      type: "tool",
      id: "tool-small",
      state: "completed",
      toolCallId: "call-small",
      toolName: "grep",
      input: { pattern: "needle" },
      result: finalizedResult("small output"),
      createdAt: 100,
      startedAt: 100,
      endedAt: 101,
    }]),
    message("msg-3", "user", [text("t3", "three")]),
    message("msg-4", "assistant", [{
      type: "tool",
      id: "tool-big",
      state: "completed",
      toolCallId: "call-big",
      toolName: "bash",
      input: "generate lots",
      result: finalizedResult("preview line", {
        kind: "artifact",
        outputRef: "abcdefghijklmnopqrstuv",
        expiresAt: 10_000,
        canRead: true,
        canSearch: true,
      }),
      createdAt: 100,
      startedAt: 100,
      endedAt: 101,
    }]),
    message("msg-5", "user", [text("t5", "tail user")]),
    message("msg-6", "assistant", [output("t6", "tail assistant")]),
  ];
}

function sessionFile(messages: StoredMessage[], compression = createEmptyCompressionState()): SessionFile {
  return {
    sessionId: "session-1",
    createdAt: 100,
    updatedAt: 100,
    cwd: "/workspace",
    agentName: "lead",
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    title: null,
    messages,
    pendingMessages: [],
    inputRequestReceipts: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    compression,
    todos: [],
    reminders: [],
    childSessionLinks: [],
    toolBatches: [],
    promptTraces: [],
    rootSessionId: "session-1",
    eventCursor: -1,
  };
}

function compressedSession(): SessionFile {
  const messages = messagesWithTools();
  const storeState: SessionStoreState = {
    sessionId: "session-1",
    createdAt: 100,
    updatedAt: 100,
    cwd: "/workspace",
    agentName: "lead",
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
    promptTraces: [],
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
    readSnapshots: new Map(),
    events: [],
    eventOffset: 0,
    nextEventId: 0,
    publishableNextEventId: 0,
    append: () => undefined,
    setCwd: () => undefined,
    setTitle: () => undefined,
    setParentSessionId: () => undefined,
    toModelMessagesProjection: () => ({ messages: [], attachmentSlots: [] }),
    toModelMessages: () => [],
  };
  const compression = prepareDynamicRangeCompression(
    storeState,
    { startId: "m0001", endId: "m0004", summary: summary() },
    1_000,
  );
  if (!compression.ok) throw new Error("test fixture compression failed");
  return sessionFile(messages, compression.state);
}

function nestedCompressedSession(): SessionFile {
  const messages = messagesWithTools();
  const storeState: SessionStoreState = {
    sessionId: "session-1",
    createdAt: 100,
    updatedAt: 100,
    cwd: "/workspace",
    agentName: "lead",
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
    promptTraces: [],
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
    readSnapshots: new Map(),
    events: [],
    eventOffset: 0,
    nextEventId: 0,
    publishableNextEventId: 0,
    append: () => undefined,
    setCwd: () => undefined,
    setTitle: () => undefined,
    setParentSessionId: () => undefined,
    toModelMessagesProjection: () => ({ messages: [], attachmentSlots: [] }),
    toModelMessages: () => [],
  };
  const child = prepareDynamicRangeCompression(
    storeState,
    { startId: "m0002", endId: "m0003", summary: summary() },
    1_000,
  );
  if (!child.ok) throw new Error("test fixture child compression failed");

  const parent = prepareDynamicRangeCompression(
    { ...storeState, compression: child.state },
    { startId: "m0001", endId: "m0004", summary: summary(["b1"]) },
    2_000,
  );
  if (!parent.ok) throw new Error("test fixture parent compression failed");
  return sessionFile(messages, parent.state);
}

describe("resolveCompressionOriginalRange", () => {
  test("returns canonical covered messages and ids for a DCP-like dynamic compression block", () => {
    const result = resolveCompressionOriginalRange(compressedSession(), "b1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.blockRef).toBe("b1");
    expect(result.strategy).toBe("dynamic-range");
    expect(result.coveredRefs).toEqual(["m0001", "m0002", "m0003", "m0004"]);
    expect(result.coveredMessageIds).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
    expect(result.messages.map((entry) => entry.message.id)).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
    expect(result.messages[0]?.message.parts[0]).toMatchObject({ type: "text", text: "one" });
    expect(result.messages[1]?.message.parts[0]).toMatchObject({
      type: "tool",
      state: "completed",
      result: { output: { preview: "small output", recovery: { kind: "none" } } },
    });
  });

  test("returns bounded preview plus opaque artifact ref without filesystem paths", () => {
    const result = resolveCompressionOriginalRange(compressedSession(), "b1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const part = result.messages[3]?.message.parts[0];
    expect(part).toMatchObject({
      type: "tool",
      state: "completed",
      result: {
        output: {
          preview: "preview line",
          recovery: {
            kind: "artifact",
            outputRef: "abcdefghijklmnopqrstuv",
          },
        },
      },
    });
    expect(JSON.stringify(part)).not.toContain("/private/tmp/secret/full.txt");
  });

  test("returns requested block child refs for nested compression parents", () => {
    const result = resolveCompressionOriginalRange(nestedCompressedSession(), "b2");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.blockRef).toBe("b2");
    expect(result.childBlockRefs).toEqual(["b1"]);
  });

  test("returns not_found for unknown refs when dynamic compression state exists", () => {
    const result = resolveCompressionOriginalRange(compressedSession(), "b9");

    expect(result).toMatchObject({ ok: false, code: "not_found", blockRef: "b9" });
  });

  test("returns not_found for hard-compacted sessions without a dynamic compression block", () => {
    const result = resolveCompressionOriginalRange(sessionFile([
      message("hard-compact", "user", [{ type: "compaction", id: "compact-1", summary: "summary", tailStartId: "tail", compactedAt: 100 }]),
      message("tail", "user", [text("tail-text", "tail")]),
    ]), "b1");

    expect(result).toMatchObject({ ok: false, code: "not_found", reason: "compression_block_not_found", blockRef: "b1" });
  });
});
