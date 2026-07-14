import { describe, expect, test } from "bun:test";
import { createEmptySessionStats } from "@archcode/protocol";
import { createEmptyCompressionState, prepareDynamicRangeCompression } from "./index";
import { resolveCompressionOriginalRange } from "./original-range";
import type { CompressionSummary } from "./types";
import type { SessionFile } from "../store/helpers";
import type { SessionStoreState, StoredMessage } from "../store/types";

function summary(childBlockRefs: CompressionSummary["childBlockRefs"] = []): CompressionSummary {
  return {
    childBlockRefs,
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

function text(id: string, value: string): StoredMessage["parts"][number] {
  return { type: "text", id, text: value, createdAt: 100, completedAt: 101 };
}

function message(id: string, role: StoredMessage["role"], parts: StoredMessage["parts"]): StoredMessage {
  return { id, role, parts, createdAt: 100, completedAt: 101 };
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
      output: "small output",
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
      output: "preview line\n[Output truncated; full output saved to: /private/tmp/secret/full.txt]",
      createdAt: 100,
      startedAt: 100,
      endedAt: 101,
      meta: { fullOutputPath: "/private/tmp/secret/full.txt" },
    }]),
    message("msg-5", "user", [text("t5", "tail user")]),
    message("msg-6", "assistant", [text("t6", "tail assistant")]),
  ];
}

function sessionFile(messages: StoredMessage[], compression = createEmptyCompressionState()): SessionFile {
  return {
    sessionId: "session-1",
    createdAt: 100,
    updatedAt: 100,
    cwd: "/workspace",
    agentName: "engineer",
    modelInfo: null,
    title: null,
    messages,
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    compression,
    todos: [],
    reminders: [],
    childSessionLinks: [],
    rootSessionId: "session-1",
  };
}

function compressedSession(): SessionFile {
  const messages = messagesWithTools();
  const storeState: SessionStoreState = {
    sessionId: "session-1",
    createdAt: 100,
    updatedAt: 100,
    cwd: "/workspace",
    agentName: "engineer",
    modelInfo: null,
    title: null,
    messages,
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    compression: createEmptyCompressionState(),
    todos: [],
    reminders: [],
    childSessionLinks: [],
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
    append: () => undefined,
    setCwd: () => undefined,
    setTitle: () => undefined,
    setParentSessionId: () => undefined,
    setGoalId: () => undefined,
    setSessionRole: () => undefined,
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
    agentName: "engineer",
    modelInfo: null,
    title: null,
    messages,
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    compression: createEmptyCompressionState(),
    todos: [],
    reminders: [],
    childSessionLinks: [],
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
    append: () => undefined,
    setCwd: () => undefined,
    setTitle: () => undefined,
    setParentSessionId: () => undefined,
    setGoalId: () => undefined,
    setSessionRole: () => undefined,
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
    expect(result.messages[1]?.message.parts[0]).toMatchObject({ type: "tool", state: "completed", output: "small output" });
  });

  test("represents persisted giant tool output as preview plus safe ref without leaking paths", () => {
    const result = resolveCompressionOriginalRange(compressedSession(), "b1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const part = result.messages[3]?.message.parts[0];
    expect(part).toMatchObject({
      type: "tool",
      state: "completed",
      output: "preview line",
      persistedOutput: {
        kind: "tool-output",
        ref: "session-1:bash:call-big",
        truncated: true,
        preview: "preview line",
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
