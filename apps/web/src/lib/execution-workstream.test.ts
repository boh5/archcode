import { describe, expect, test } from "bun:test";
import type {
  CompressionBlockSnapshot,
  CompressionStateSnapshot,
  ExecutionModelBindingSummary,
  SessionExecutionRecord,
  SessionMessage,
  SessionPart,
  ToolChildSessionLink,
  ToolPart,
} from "@archcode/protocol";
import {
  buildExecutionWorkstream,
  type ExecutionWorkstreamInput,
} from "./execution-workstream";

const BINDING: ExecutionModelBindingSummary = {
  selection: { model: "local:test" },
  providerId: "local",
  modelId: "test",
  providerDisplayName: "Local",
  modelDisplayName: "Test",
  resolution: "profile_default",
  modelRuntimeRevision: "revision-1",
};

function execution(
  id: string,
  startedAt: number,
  overrides: Partial<SessionExecutionRecord> = {},
): SessionExecutionRecord {
  return {
    id,
    startedAt,
    status: "completed",
    endedAt: startedAt + 10,
    durationMs: 10,
    binding: BINDING,
    origin: "user_message",
    ...overrides,
  };
}

function text(id: string, value: string, createdAt: number): SessionPart {
  return { type: "text", id, text: value, createdAt, completedAt: createdAt };
}

function pendingTool(
  id: string,
  toolName: string,
  toolCallId: string,
  createdAt: number,
): ToolPart {
  return {
    type: "tool",
    id,
    state: "pending",
    toolCallId,
    toolName,
    createdAt,
  };
}

function message(
  id: string,
  role: SessionMessage["role"],
  parts: SessionPart[],
  executionId?: string,
): SessionMessage {
  return {
    id,
    role,
    parts,
    createdAt: parts[0]?.type === "compaction"
      ? parts[0].compactedAt
      : parts[0] && "createdAt" in parts[0]
        ? parts[0].createdAt
        : 0,
    ...(executionId === undefined ? {} : { executionId }),
  };
}

function childLink(
  parentToolCallId: string,
  childSessionId: string,
): ToolChildSessionLink {
  return {
    parentSessionId: "root",
    parentToolCallId,
    toolName: "delegate",
    childSessionId,
    childAgentName: "build",
    childProfile: "deep",
    childSkillNames: [],
    title: "Build child",
    depth: 1,
    background: false,
    status: "completed",
    createdAt: 1,
  };
}

function compressionSnapshot(
  ref: CompressionBlockSnapshot["ref"],
  overrides: Partial<CompressionBlockSnapshot> = {},
): CompressionBlockSnapshot {
  return {
    id: `snapshot-${ref}`,
    ref,
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    range: {
      startMessageId: "message-1",
      endMessageId: "message-2",
      startRef: "m0001",
      endRef: "m0002",
      startIndex: 0,
      endIndex: 1,
    },
    summary: "Snapshot summary",
    childBlockRefs: [],
    protectedRefs: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function input(overrides: Partial<ExecutionWorkstreamInput> = {}): ExecutionWorkstreamInput {
  return {
    messages: [],
    executions: [],
    childSessionLinks: [],
    session: { agentName: "lead", profile: "principal" },
    agentDescriptors: [{ name: "lead", displayName: "Lead" }],
    ...overrides,
  };
}

describe("buildExecutionWorkstream", () => {
  test("sorts and numbers Executions, derives all four origin titles, and closes Session identity", () => {
    const records = [
      execution("tools", 30, { origin: "tool_batch", status: "waiting_for_human" }),
      execution("user-b", 10),
      execution("goal", 20, { origin: "goal_continuation", status: "running" }),
      execution("user-a", 10, { origin: "tool_call", status: "failed" }),
    ];
    const userMessage = message("message-user", "user", [
      text("blank", "\n   \n", 10),
      text("title", "  Ship the workbench  \nwith details", 11),
    ], "user-b");

    const result = buildExecutionWorkstream(input({
      executions: records,
      messages: [userMessage],
      session: { agentName: "build", profile: "fast" },
      agentDescriptors: [
        { name: "lead", displayName: "Lead" },
        { name: "build", displayName: "Builder" },
      ],
    }));

    expect(result.executions.map(({ id, number, title }) => ({ id, number, title }))).toEqual([
      { id: "user-a", number: 1, title: "Continue after tool response" },
      { id: "user-b", number: 2, title: "Ship the workbench" },
      { id: "goal", number: 3, title: "Continue active goal" },
      { id: "tools", number: 4, title: "Continue after tool responses" },
    ]);
    expect(result.executions[2]?.record.status).toBe("running");
    expect(result.executions[3]?.record.status).toBe("waiting_for_human");
    expect(result.session).toEqual({ agentName: "build", profile: "fast", displayName: "Builder" });
  });

  test("does not invent a display name or user_message title when authoritative input is absent", () => {
    const result = buildExecutionWorkstream(input({
      executions: [execution("no-title", 1)],
      session: { agentName: "custom", profile: "deep" },
      agentDescriptors: [],
    }));

    expect(result.session).toEqual({ agentName: "custom", profile: "deep" });
    expect(result.executions[0]?.title).toBeNull();
  });

  test("preserves message and part order while counting every Tool and only resolvable delegate children", () => {
    const firstParts: SessionPart[] = [
      text("agent-before", "Before", 2),
      pendingTool("delegate", "delegate", "delegate-call", 3),
      text("agent-middle", "Middle", 4),
      pendingTool("read", "file_read", "read-call", 5),
      text("agent-final", "Final", 6),
    ];
    const first = message("assistant-1", "assistant", firstParts, "execution-1");
    const second = message("assistant-2", "assistant", [
      pendingTool("bash", "bash", "bash-call", 7),
    ], "execution-1");
    const matching = childLink("delegate-call", "child-1");

    const result = buildExecutionWorkstream(input({
      executions: [execution("execution-1", 1)],
      messages: [first, second],
      childSessionLinks: [matching, childLink("unrelated-call", "child-2")],
    }));
    const projected = result.executions[0]!;

    expect(projected.messages).toEqual([first, second]);
    expect(projected.messages[0]).toBe(first);
    expect(projected.messages[0]?.parts).toBe(firstParts);
    expect(projected.messages[0]?.parts.map((part) => part.id)).toEqual([
      "agent-before", "delegate", "agent-middle", "read", "agent-final",
    ]);
    expect(projected.toolCount).toBe(3);
    expect(projected.childCount).toBe(1);
    expect(projected.childSessionLinks).toEqual([matching]);
  });

  test("merges Session activity with the exact timestamp, rank, and stable identity tie-breaks", () => {
    const activityZ = message("z-message", "assistant", [
      { type: "system-notice", id: "notice", notice: "Notice", createdAt: 90 },
      { type: "compaction", id: "compact", summary: "Compact", tailStartId: "tail", compactedAt: 100 },
    ]);
    const activityA = message("a-message", "assistant", [
      { type: "system-notice", id: "notice-a", notice: "Notice A", createdAt: 100 },
    ]);
    const blockZ = compressionSnapshot("b2", { id: "z-block", createdAt: 100 });
    const blockA = compressionSnapshot("b1", { id: "a-block", createdAt: 100 });
    const compression: CompressionStateSnapshot = {
      refMap: {
        messageRefsById: {},
        messageIdsByRef: {},
        blockRefsById: { "z-block": "b2", "a-block": "b1" },
        blockIdsByRef: { b2: "z-block", b1: "a-block" },
        nextMessageIndex: 1,
        nextBlockIndex: 3,
      },
      blocksByRef: { b2: blockZ, b1: blockA },
      activeBlockRefs: ["b2", "b1"],
      inactiveBlockRefs: [],
      supersededBlockRefs: [],
      failures: [],
      updatedAt: 100,
    };

    const result = buildExecutionWorkstream(input({
      executions: [execution("execution", 100, { origin: "goal_continuation" })],
      messages: [activityZ, activityA],
      compression,
    }));

    expect(result.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "execution:execution",
      "activity-message:a-message",
      "activity-message:z-message",
      "compression:compression:b1:a-block",
      "compression:compression:b2:z-block",
    ]);
    expect(result.items[2]?.sortTime).toBe(100);
    expect(result.diagnostics).toEqual([]);
  });

  test("keeps linked activity in its Execution and diagnoses a pure activity with an unknown ID", () => {
    const linked = message("linked", "assistant", [
      { type: "compaction", id: "linked-compact", summary: "Done", tailStartId: "tail", compactedAt: 3 },
    ], "execution");
    const unknown = message("unknown", "assistant", [
      { type: "system-notice", id: "unknown-notice", notice: "Unknown", createdAt: 4 },
    ], "missing");

    const result = buildExecutionWorkstream(input({
      executions: [execution("execution", 1, { origin: "goal_continuation" })],
      messages: [linked, unknown],
    }));

    expect(result.executions[0]?.messages).toEqual([linked]);
    expect(result.items.some((item) => item.kind === "activity-message")).toBe(false);
    expect(result.diagnostics).toEqual([
      { code: "unknown_execution", executionId: "missing", message: unknown },
    ]);
  });

  test("returns typed diagnostics without discarding or duplicating affected message content", () => {
    const orphan = message("orphan", "user", [text("orphan-text", "Orphan", 1)]);
    const unknown = message("unknown", "assistant", [text("unknown-text", "Unknown", 2)], "missing");
    const duplicate = message("duplicate", "assistant", [text("duplicate-text", "Duplicate", 3)], "duplicate-id");
    const valid = message("valid", "user", [text("valid-text", "Valid", 4)], "valid-id");
    const duplicateRecords = [
      execution("duplicate-id", 2),
      execution("duplicate-id", 1),
    ];

    const result = buildExecutionWorkstream(input({
      executions: [...duplicateRecords, execution("valid-id", 4)],
      messages: [orphan, unknown, duplicate, valid],
    }));

    expect(result.executions.map(({ id }) => id)).toEqual(["valid-id"]);
    expect(result.executions[0]?.messages).toEqual([valid]);
    expect(result.diagnostics).toEqual([
      { code: "orphan_message", message: orphan },
      { code: "unknown_execution", executionId: "missing", message: unknown },
      {
        code: "duplicate_execution",
        executionId: "duplicate-id",
        records: duplicateRecords,
        messages: [duplicate],
      },
    ]);
    expect(result.items.flatMap((item) => item.kind === "execution" ? item.messages : []).includes(duplicate)).toBe(false);
  });

  test("derives stable Dynamic Compression cards only from the authoritative snapshot", () => {
    const snapshot = compressionSnapshot("b1", {
      id: "block-id",
      status: "superseded",
      summary: "Authoritative summary",
      createdAt: 20,
    });
    const compression: CompressionStateSnapshot = {
      refMap: {
        messageRefsById: {},
        messageIdsByRef: {},
        blockRefsById: { [snapshot.id]: "b1" },
        blockIdsByRef: { b1: snapshot.id },
        nextMessageIndex: 1,
        nextBlockIndex: 2,
      },
      blocksByRef: { b1: snapshot },
      activeBlockRefs: [],
      inactiveBlockRefs: [],
      supersededBlockRefs: ["b1"],
      failures: [],
      updatedAt: 21,
    };

    const liveResult = buildExecutionWorkstream(input({ compression }));
    const coldResult = buildExecutionWorkstream(input({ compression }));
    const item = liveResult.items[0];

    expect(item?.kind).toBe("compression");
    if (item?.kind === "compression") {
      expect(item.id).toBe("compression:b1:block-id");
      expect(item.block.status).toBe("superseded");
      expect(item.block.summary).toBe("Authoritative summary");
      expect(item.snapshot).toBe(snapshot);
    }
    expect(coldResult.items[0]).toEqual(item);
    expect(liveResult.compression).toBe(compression);
  });

  test("processes the 1,000 Execution / 10,000 message / 20,000 part fixture as a pure projection", () => {
    const executions = Array.from({ length: 1_000 }, (_, index) =>
      execution(`execution-${String(index).padStart(4, "0")}`, index, { origin: "goal_continuation" }));
    const messages = Array.from({ length: 10_000 }, (_, index) => {
      const executionIndex = Math.floor(index / 10);
      return message(`message-${index}`, "assistant", [
        text(`text-${index}-a`, "A", index),
        text(`text-${index}-b`, "B", index),
      ], `execution-${String(executionIndex).padStart(4, "0")}`);
    });

    const result = buildExecutionWorkstream(input({ executions, messages }));

    expect(result.executions).toHaveLength(1_000);
    expect(result.executions[0]?.messages).toHaveLength(10);
    expect(result.executions[999]?.messages).toHaveLength(10);
    expect(result.executions.reduce(
      (count, item) => count + item.messages.reduce((parts, entry) => parts + entry.parts.length, 0),
      0,
    )).toBe(20_000);
    expect(result.diagnostics).toEqual([]);
    expect(messages[0]?.parts[0]?.id).toBe("text-0-a");
  });
});
