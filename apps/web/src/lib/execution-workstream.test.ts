import { describe, expect, test } from "bun:test";
import type {
  CompressionBlockSnapshot,
  CompressionStateSnapshot,
  ExecutionModelBindingSummary,
  SessionExecutionRecord,
  SessionMessage,
  SessionPart,
  SessionStep,
  TextPart,
  ToolChildSessionLink,
  ToolPart,
} from "@archcode/protocol";
import {
  buildExecutionWorkstream,
  stabilizeExecutionWorkstreamProjection,
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
  completed = true,
): SessionMessage {
  const createdAt = parts[0]?.type === "compaction"
    ? parts[0].compactedAt
    : parts[0] && "createdAt" in parts[0]
      ? parts[0].createdAt
      : 0;
  return {
    id,
    role,
    parts,
    createdAt,
    ...(completed ? { completedAt: createdAt } : {}),
    ...(executionId === undefined ? {} : { executionId }),
  };
}

function step(
  executionId: string,
  stepNumber: number,
  finishReason: string | undefined = "stop",
  overrides: Partial<SessionStep> = {},
): SessionStep {
  const startedAt = stepNumber * 10 + 1;
  return {
    id: `${executionId}:step:${stepNumber}:${startedAt}`,
    step: stepNumber,
    executionId,
    startedAt,
    completedAt: startedAt + 1,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...overrides,
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
    steps: [],
    childSessionLinks: [],
    session: { agentName: "lead", profile: "principal" },
    agentDescriptors: [{ name: "lead", displayName: "Lead" }],
    ...overrides,
  };
}

describe("buildExecutionWorkstream", () => {
  test("sorts and numbers Executions, projects canonical user input, and closes Session identity", () => {
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

    expect(result.executions.map(({ id, number }) => ({ id, number }))).toEqual([
      { id: "user-a", number: 1 },
      { id: "user-b", number: 2 },
      { id: "goal", number: 3 },
      { id: "tools", number: 4 },
    ]);
    expect(result.executions[1]?.userMessages).toEqual([userMessage]);
    expect(result.executions[2]?.record.status).toBe("running");
    expect(result.executions[3]?.record.status).toBe("waiting_for_human");
    expect(result.session).toEqual({ agentName: "build", profile: "fast", displayName: "Builder" });
  });

  test("does not invent a display name when authoritative input is absent", () => {
    const result = buildExecutionWorkstream(input({
      executions: [execution("no-title", 1)],
      session: { agentName: "custom", profile: "deep" },
      agentDescriptors: [],
    }));

    expect(result.session).toEqual({ agentName: "custom", profile: "deep" });
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

    expect(projected.workMessages.map(({ message }) => message)).toEqual([first, second]);
    expect(projected.workMessages[0]?.message).toBe(first);
    expect(projected.workMessages[0]?.parts).toBe(firstParts);
    expect(projected.workMessages[0]?.parts.map((part) => part.id)).toEqual([
      "agent-before", "delegate", "agent-middle", "read", "agent-final",
    ]);
    expect(projected.toolCount).toBe(3);
    expect(projected.childCount).toBe(1);
    expect(projected.childSessionLinks).toEqual([matching]);
  });

  test("splits canonical input, Work parts, and the terminal Assistant text without copying references", () => {
    const user = message("user", "user", [text("user-text", "Please implement it", 1)], "execution");
    const toolStep = message("tool-step", "assistant", [
      { type: "reasoning", id: "reasoning-work", text: "Inspect first", createdAt: 2, completedAt: 2 },
      text("progress", "I am inspecting it.", 3),
      pendingTool("read", "file_read", "read-call", 4),
    ], "execution");
    const finalParts: SessionPart[] = [
      { type: "reasoning", id: "reasoning-final", text: "Verified", createdAt: 5, completedAt: 5 },
      text("final-a", "Implemented.", 6),
      { type: "recovery-notice", id: "recovered", status: "recovered", message: "Recovered", attempt: 1, createdAt: 7, completedAt: 7 },
      text("final-b", "\nTests pass.", 8),
    ];
    const finalTextParts = finalParts.filter((part): part is TextPart => part.type === "text");
    const final = message("final", "assistant", finalParts, "execution");

    const result = buildExecutionWorkstream(input({
      executions: [execution("execution", 1)],
      messages: [user, toolStep, final],
      steps: [
        step("execution", 0, "tool-calls"),
        step("execution", 1, "stop"),
      ],
    }));
    const projected = result.executions[0]!;

    expect(projected.userMessages).toEqual([user]);
    expect(projected.userMessages[0]).toBe(user);
    expect(projected.stepCount).toBe(2);
    expect(projected.finalResponse?.message).toBe(final);
    expect(projected.finalResponse?.textParts).toEqual(finalTextParts);
    expect(projected.finalResponse?.textParts[0]).toBe(finalTextParts[0]);
    expect(projected.workMessages).toHaveLength(2);
    expect(projected.workMessages[0]).toEqual({ message: toolStep, parts: toolStep.parts });
    expect(projected.workMessages[0]?.parts).toBe(toolStep.parts);
    expect(projected.workMessages[1]?.message).toBe(final);
    expect(projected.workMessages[1]?.parts).toEqual([finalParts[0], finalParts[2]]);
    expect(projected.workMessages[1]?.parts[0]).toBe(finalParts[0]);
  });

  test("keeps historical user text outside Work without requiring modelAudit", () => {
    const historicalUser = message("historical-user", "user", [
      text("historical-text", "Old canonical input", 1),
    ], "execution");
    const internalNotice = message("notice-message", "user", [{
      type: "system-notice",
      id: "notice",
      notice: "Internal activity",
      createdAt: 2,
      completedAt: 2,
    }], "execution");

    const result = buildExecutionWorkstream(input({
      executions: [execution("execution", 1)],
      messages: [historicalUser, internalNotice],
    }));
    const projected = result.executions[0]!;

    expect(projected.userMessages).toEqual([historicalUser]);
    expect(projected.workMessages).toEqual([{ message: internalNotice, parts: internalNotice.parts }]);
  });

  test("does not fabricate a final response when a Tool ends a completed Execution", () => {
    const earlierText = message("earlier", "assistant", [
      text("earlier-text", "Progress, not a final answer", 2),
    ], "execution");
    const terminalTool = message("terminal-tool", "assistant", [
      pendingTool("complete", "update_goal", "complete-call", 3),
    ], "execution");

    const result = buildExecutionWorkstream(input({
      executions: [execution("execution", 1)],
      messages: [earlierText, terminalTool],
      steps: [step("execution", 0, "tool-calls")],
    }));
    const projected = result.executions[0]!;

    expect(projected.finalResponse).toBeUndefined();
    expect(projected.workMessages.map(({ message }) => message)).toEqual([earlierText, terminalTool]);
  });

  test("uses authoritative Step order instead of input array order", () => {
    const final = message("final", "assistant", [text("final-text", "Done", 30)], "execution");
    const result = buildExecutionWorkstream(input({
      executions: [execution("execution", 1)],
      messages: [final],
      steps: [
        step("execution", 1, "stop", { startedAt: 30, completedAt: 31 }),
        step("execution", 0, "tool-calls", { startedAt: 10, completedAt: 11 }),
      ],
    }));

    expect(result.executions[0]?.stepCount).toBe(2);
    expect(result.executions[0]?.finalResponse?.textParts).toEqual(
      final.parts.filter((part): part is TextPart => part.type === "text"),
    );
  });

  test("fails closed for non-completed Executions and non-terminal model Steps", () => {
    const statuses: SessionExecutionRecord["status"][] = [
      "running",
      "failed",
      "aborted",
      "cancelled",
      "timed_out",
      "interrupted",
      "waiting_for_human",
      "max_steps",
    ];
    const executions = statuses.map((status, index) =>
      execution(`execution-${status}`, index, { status }));
    const messages = statuses.map((status, index) =>
      message(`message-${status}`, "assistant", [
        text(`text-${status}`, `Output ${status}`, index + 1),
      ], `execution-${status}`));
    const steps = statuses.map((status, index) =>
      step(`execution-${status}`, index, "stop"));
    const completedCases = [
      { id: "missing-step", steps: [] as SessionStep[] },
      { id: "open-step", steps: [step("open-step", 0, "stop", { completedAt: undefined })] },
      { id: "missing-finish", steps: [step("missing-finish", 0, "stop", { finishReason: undefined })] },
      { id: "interrupted-step", steps: [step("interrupted-step", 0, "interrupted")] },
      { id: "error-step", steps: [step("error-step", 0, "error")] },
    ];

    const result = buildExecutionWorkstream(input({
      executions: [
        ...executions,
        ...completedCases.map(({ id }, index) => execution(id, 100 + index)),
      ],
      messages: [
        ...messages,
        ...completedCases.map(({ id }, index) =>
          message(`message-${id}`, "assistant", [text(`text-${id}`, "Not final", 100 + index)], id)),
      ],
      steps: [...steps, ...completedCases.flatMap(({ steps: caseSteps }) => caseSteps)],
    }));

    expect(result.executions.every(({ finalResponse }) => finalResponse === undefined)).toBe(true);
  });

  test("does not fall back when the last Assistant message has no trusted completed text", () => {
    const earlier = message("earlier", "assistant", [text("earlier-text", "Earlier", 2)], "execution");
    const latestParts: SessionPart[] = [
      { type: "text", id: "discarded", text: "Partial", createdAt: 3, completedAt: 3, meta: { interrupted: true, discardedFromContext: true } },
      text("blank", " \n ", 4),
    ];
    const latest = message("latest", "assistant", latestParts, "execution");
    const result = buildExecutionWorkstream(input({
      executions: [execution("execution", 1)],
      messages: [earlier, latest],
      steps: [step("execution", 0, "stop")],
    }));
    const projected = result.executions[0]!;

    expect(projected.finalResponse).toBeUndefined();
    expect(projected.workMessages.map(({ message }) => message)).toEqual([earlier, latest]);
  });

  test("extracts recovered final Text parts while keeping discarded text, Tool, Reasoning, and Recovery in Work", () => {
    const parts: SessionPart[] = [
      { type: "text", id: "discarded", text: "Interrupted partial", createdAt: 2, completedAt: 2, meta: { interrupted: true, discardedFromContext: true } },
      pendingTool("recovered-tool", "file_read", "read-call", 3),
      { type: "reasoning", id: "reasoning", text: "Retry", createdAt: 4, completedAt: 4 },
      { type: "recovery-notice", id: "recovery", status: "recovered", message: "Recovered", attempt: 1, createdAt: 5, completedAt: 5 },
      text("final-a", "Recovered", 6),
      text("final-b", " final", 7),
    ];
    const recovered = message("recovered", "assistant", parts, "execution");
    const result = buildExecutionWorkstream(input({
      executions: [execution("execution", 1)],
      messages: [recovered],
      steps: [step("execution", 0, "stop")],
    }));
    const projected = result.executions[0]!;

    expect(projected.finalResponse?.textParts).toEqual(
      parts.filter((part): part is TextPart =>
        part.type === "text" && part.meta?.discardedFromContext !== true
      ),
    );
    expect(projected.workMessages).toEqual([{
      message: recovered,
      parts: [parts[0], parts[1], parts[2], parts[3]],
    }]);
  });

  test("rejects an incomplete last Assistant message instead of falling back", () => {
    const earlier = message("earlier", "assistant", [text("earlier-text", "Earlier", 2)], "execution");
    const latest = message("latest", "assistant", [
      { type: "text", id: "streaming", text: "Still streaming", createdAt: 3 },
    ], "execution", false);
    const result = buildExecutionWorkstream(input({
      executions: [execution("execution", 1)],
      messages: [earlier, latest],
      steps: [step("execution", 0, "stop")],
    }));

    expect(result.executions[0]?.finalResponse).toBeUndefined();
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

    expect(result.executions[0]?.workMessages).toEqual([{ message: linked, parts: linked.parts }]);
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
    expect(result.executions[0]?.userMessages).toEqual([valid]);
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
    expect(result.items.flatMap((item) =>
      item.kind === "execution"
        ? [...item.userMessages, ...item.workMessages.map(({ message }) => message)]
        : []
    ).includes(duplicate)).toBe(false);
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
    expect(result.executions[0]?.workMessages).toHaveLength(10);
    expect(result.executions[999]?.workMessages).toHaveLength(10);
    expect(result.executions.reduce(
      (count, item) => count + item.workMessages.reduce((parts, entry) => parts + entry.parts.length, 0),
      0,
    )).toBe(20_000);
    expect(result.diagnostics).toEqual([]);
    expect(messages[0]?.parts[0]?.id).toBe("text-0-a");
  });

  test("reuses 999 historical Execution projections when only the active turn streams", () => {
    const executions = Array.from({ length: 1_000 }, (_, index) =>
      execution(`execution-${String(index).padStart(4, "0")}`, index, {
        origin: "goal_continuation",
        ...(index === 999 ? { status: "running", endedAt: undefined, durationMs: undefined } : {}),
      }));
    const messages = Array.from({ length: 10_000 }, (_, index) => {
      const executionIndex = Math.floor(index / 10);
      return message(`message-${index}`, "assistant", [
        text(`text-${index}`, `Message ${index}`, index),
      ], `execution-${String(executionIndex).padStart(4, "0")}`);
    });
    const first = buildExecutionWorkstream(input({ executions, messages }));
    const streamedMessage = message(
      "message-streamed",
      "assistant",
      [text("text-streamed", "New active delta", 10_001)],
      "execution-0999",
    );
    const next = buildExecutionWorkstream(input({
      executions,
      messages: [...messages, streamedMessage],
    }));

    const stable = stabilizeExecutionWorkstreamProjection(first, next);
    const changedExecutions = stable.executions.filter(
      (execution, index) => execution !== first.executions[index],
    );

    expect(changedExecutions.map(({ id }) => id)).toEqual(["execution-0999"]);
    expect(stable.executions[0]).toBe(first.executions[0]);
    expect(stable.executions[998]).toBe(first.executions[998]);
    expect(stable.executions[999]).not.toBe(first.executions[999]);
    expect(stable.items[0]).toBe(first.items[0]);
    expect(stable.session).toBe(first.session);
  });
});
