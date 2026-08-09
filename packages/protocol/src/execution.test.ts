import { describe, expect, test } from "bun:test";
import { validateExecutionTransition } from "./execution";
import { reduceStreamEvent } from "./reduce";
import { createEmptySessionStats } from "./usage";
import type {
  ExecutionLifecycleEvent,
  SessionExecutionRecord,
  SessionProjection,
  StreamEvent,
} from "./types";

const binding = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "runtime-1",
};
const usage = createEmptySessionStats().usage;

function projection(): SessionProjection {
  return {
    sessionId: "session-1",
    cwd: "/workspace",
    rootSessionId: "session-1",
    title: null,
    messages: [],
    pendingMessages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionLinks: [],
    stats: createEmptySessionStats(),
    executions: [],
    executionCount: 0,
    isRunning: false,
    isStreamingModel: false,
    modelSelection: { revision: 0 },
  };
}

function apply(state: SessionProjection, event: StreamEvent, timestamp: number): SessionProjection {
  return {
    ...state,
    ...reduceStreamEvent(state, event, { timestamp, generateId: () => crypto.randomUUID() }),
  };
}

function runSettlement(ordinal: number) {
  return { key: `run:session-1:execution-1:${ordinal}`, goalInstanceId: null };
}

function terminalSettlement() {
  return { key: "terminal:session-1:execution-1", goalInstanceId: null };
}

function start(): Extract<ExecutionLifecycleEvent, { type: "execution-start" }> {
  return {
    type: "execution-start",
    executionId: "execution-1",
    origin: "user_message",
    maxSteps: 50,
    binding,
    executionSkills: [],
  };
}

function suspend(
  ordinal: number,
  suspension: Extract<ExecutionLifecycleEvent, { type: "execution-suspended" }>['suspension'],
): Extract<ExecutionLifecycleEvent, { type: "execution-suspended" }> {
  return {
    type: "execution-suspended",
    executionId: "execution-1",
    suspension,
    runEndedAt: 10 + ordinal * 10,
    runUsageDelta: usage,
    runSettlement: runSettlement(ordinal),
  };
}

function resume(runOrdinal: number): Extract<ExecutionLifecycleEvent, { type: "execution-resumed" }> {
  return { type: "execution-resumed", executionId: "execution-1", runOrdinal, binding };
}

function endRunning(ordinal: number): Extract<ExecutionLifecycleEvent, { type: "execution-end" }> {
  return {
    type: "execution-end",
    executionId: "execution-1",
    terminalStatus: "completed",
    endedAt: 15 + ordinal * 10,
    runEndedAt: 15 + ordinal * 10,
    runUsageDelta: usage,
    runSettlement: runSettlement(ordinal),
    terminalSettlement: terminalSettlement(),
  };
}

function endSuspended(): Extract<ExecutionLifecycleEvent, { type: "execution-end" }> {
  return {
    type: "execution-end",
    executionId: "execution-1",
    terminalStatus: "cancelled",
    endedAt: 15,
    terminalSettlement: terminalSettlement(),
  };
}

function execution(state: SessionProjection): SessionExecutionRecord {
  const record = state.executions[0];
  if (!record) throw new Error("expected an Execution");
  return record;
}

describe("logical Execution lifecycle", () => {
  test("keeps two HITL suspensions and resumes inside one logical record", () => {
    let state = apply(projection(), {
      type: "execution-start",
      executionId: "execution-1",
      origin: "user_message",
      maxSteps: 50,
      binding,
      executionSkills: [],
    }, 0);
    state = apply(state, {
      type: "execution-suspended",
      executionId: "execution-1",
      suspension: { kind: "hitl", toolBatchId: "batch-1", blockerIds: ["hitl-1"] },
      runEndedAt: 10,
      runUsageDelta: usage,
      runSettlement: runSettlement(0),
    }, 11);
    state = apply(state, {
      type: "execution-suspension-updated",
      executionId: "execution-1",
      suspension: { kind: "resume_pending", toolBatchId: "batch-1", readyAt: 12 },
    }, 12);
    state = apply(state, {
      type: "execution-resumed",
      executionId: "execution-1",
      runOrdinal: 1,
      binding,
    }, 20);
    state = apply(state, {
      type: "execution-suspended",
      executionId: "execution-1",
      suspension: { kind: "hitl", toolBatchId: "batch-2", blockerIds: ["hitl-2"] },
      runEndedAt: 30,
      runUsageDelta: usage,
      runSettlement: runSettlement(1),
    }, 31);
    state = apply(state, {
      type: "execution-suspension-updated",
      executionId: "execution-1",
      suspension: { kind: "resume_pending", toolBatchId: "batch-2", readyAt: 32 },
    }, 32);
    state = apply(state, {
      type: "execution-resumed",
      executionId: "execution-1",
      runOrdinal: 2,
      binding,
    }, 40);
    state = apply(state, {
      type: "execution-end",
      executionId: "execution-1",
      terminalStatus: "completed",
      endedAt: 50,
      runEndedAt: 50,
      runUsageDelta: usage,
      runSettlement: runSettlement(2),
      terminalSettlement: terminalSettlement(),
    }, 51);

    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]).toMatchObject({
      id: "execution-1",
      status: "completed",
      durationMs: 30,
      runs: [
        { ordinal: 0, startedAt: 0, endedAt: 10, durationMs: 10 },
        { ordinal: 1, startedAt: 20, endedAt: 30, durationMs: 10 },
        { ordinal: 2, startedAt: 40, endedAt: 50, durationMs: 10 },
      ],
    });
    expect(state.executionCount).toBe(1);
    expect(state.currentExecutionId).toBeUndefined();
  });

  test("suspension releases live flags without terminal tool or assistant cleanup", () => {
    let state = apply(projection(), {
      type: "execution-start",
      executionId: "execution-1",
      origin: "user_message",
      maxSteps: 50,
      binding,
      executionSkills: [],
    }, 0);
    state = apply(state, {
      type: "step-start",
      stepId: "step-1",
      step: 0,
    }, 1);
    state = apply(state, {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "ask_user",
      input: {},
    }, 2);
    const assistantMessageId = state.currentAssistantMessageId;
    state = apply(state, {
      type: "execution-suspended",
      executionId: "execution-1",
      suspension: { kind: "hitl", toolBatchId: "batch-1", blockerIds: ["hitl-1"] },
      runEndedAt: 2,
      runUsageDelta: usage,
      runSettlement: runSettlement(0),
    }, 3);

    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.currentExecutionId).toBe("execution-1");
    expect(state.currentAssistantMessageId).toBe(assistantMessageId);
    expect(state.messages[0]?.completedAt).toBeUndefined();
    expect(state.messages[0]?.parts[0]).toMatchObject({ type: "tool", state: "running" });
  });

  test("accepts every legal logical Execution edge", () => {
    const hitl = { kind: "hitl" as const, toolBatchId: "batch-1", blockerIds: ["hitl-1"] };
    const hitlRefresh = { ...hitl, blockerIds: ["hitl-1", "hitl-2"] };
    const ready = { kind: "resume_pending" as const, toolBatchId: "batch-1", readyAt: 12 };

    const runningEnd = [start(), suspend(0, hitl), {
      type: "execution-suspension-updated" as const,
      executionId: "execution-1",
      suspension: hitlRefresh,
    }, {
      type: "execution-suspension-updated" as const,
      executionId: "execution-1",
      suspension: ready,
    }, resume(1), endRunning(1)];
    const suspendedEnd = [start(), suspend(0, hitl), endSuspended()];

    for (const events of [runningEnd, suspendedEnd]) {
      let state = projection();
      for (const [index, event] of events.entries()) {
        expect(validateExecutionTransition(state.executions, event)).toEqual({ outcome: "valid" });
        state = apply(state, event, [0, 10, 12, 15, 20][index]!);
      }
      expect(execution(state).status).not.toBe("running");
      expect(state.currentExecutionId).toBeUndefined();
    }
  });

  test("classifies exact lifecycle replay as duplicate and leaves the projection unchanged", () => {
    const events: ExecutionLifecycleEvent[] = [
      start(),
      suspend(0, { kind: "hitl", toolBatchId: "batch-1", blockerIds: ["hitl-1"] }),
      { type: "execution-suspension-updated", executionId: "execution-1", suspension: { kind: "resume_pending", toolBatchId: "batch-1", readyAt: 12 } },
      resume(1),
      endRunning(1),
    ];
    let state = projection();
    for (const [index, event] of events.entries()) {
      expect(validateExecutionTransition(state.executions, event)).toEqual({ outcome: "valid" });
      state = apply(state, event, [0, 10, 12, 15, 20][index]!);
      expect(validateExecutionTransition(state.executions, event)).toEqual({ outcome: "duplicate" });
    }
    const once = structuredClone(state);

    let replayed = projection();
    for (const [index, event] of [...events, ...events].entries()) {
      replayed = apply(replayed, event, [0, 10, 12, 15, 20][index % events.length]!);
    }
    expect(replayed).toEqual(once);
  });

  test("rejects a conflicting resume-pending readyAt update", () => {
    let state = apply(projection(), start(), 0);
    state = apply(state, suspend(0, {
      kind: "hitl",
      toolBatchId: "batch-1",
      blockerIds: ["hitl-1"],
    }), 10);
    state = apply(state, {
      type: "execution-suspension-updated",
      executionId: "execution-1",
      suspension: { kind: "resume_pending", toolBatchId: "batch-1", readyAt: 12 },
    }, 12);

    expect(validateExecutionTransition(state.executions, {
      type: "execution-suspension-updated",
      executionId: "execution-1",
      suspension: { kind: "resume_pending", toolBatchId: "batch-1", readyAt: 13 },
    })).toEqual({ outcome: "invalid", reason: "A resume-pending suspension cannot be updated" });
  });

  test("rejects a stale resume replay at a later resume boundary", () => {
    let state = apply(projection(), start(), 0);
    state = apply(state, suspend(0, {
      kind: "hitl",
      toolBatchId: "batch-1",
      blockerIds: ["hitl-1"],
    }), 10);
    state = apply(state, {
      type: "execution-suspension-updated",
      executionId: "execution-1",
      suspension: { kind: "resume_pending", toolBatchId: "batch-1", readyAt: 12 },
    }, 12);
    state = apply(state, resume(1), 20);
    state = apply(state, suspend(1, {
      kind: "hitl",
      toolBatchId: "batch-2",
      blockerIds: ["hitl-2"],
    }), 30);
    state = apply(state, {
      type: "execution-suspension-updated",
      executionId: "execution-1",
      suspension: { kind: "resume_pending", toolBatchId: "batch-2", readyAt: 32 },
    }, 32);
    const beforeReplay = structuredClone(state);

    expect(validateExecutionTransition(state.executions, resume(1)).outcome).toBe("invalid");
    state = apply(state, resume(1), 40);
    expect(state).toEqual(beforeReplay);

    expect(validateExecutionTransition(state.executions, resume(2))).toEqual({ outcome: "valid" });
    state = apply(state, resume(2), 40);
    expect(execution(state).runs.map((run) => run.ordinal)).toEqual([0, 1, 2]);
  });

  test("rejects conflicting duplicates and illegal lifecycle edges", () => {
    let state = apply(projection(), start(), 0);
    const running = () => state.executions;

    const invalidWhileRunning: ExecutionLifecycleEvent[] = [
      { ...start(), maxSteps: 10 },
      suspend(0, { kind: "resume_pending", toolBatchId: "batch-1", readyAt: 1 }),
      resume(0),
      resume(1),
      { ...suspend(0, { kind: "hitl", toolBatchId: "batch-1", blockerIds: ["hitl-1"] }), executionId: "wrong-id" },
    ];
    for (const event of invalidWhileRunning) {
      expect(validateExecutionTransition(running(), event).outcome).toBe("invalid");
    }

    const suspension = { kind: "hitl" as const, toolBatchId: "batch-1", blockerIds: ["hitl-1"] };
    const suspended = suspend(0, suspension);
    state = apply(state, suspended, 10);
    expect(validateExecutionTransition(running(), suspended)).toEqual({ outcome: "duplicate" });
    expect(validateExecutionTransition(running(), {
      ...suspended,
      suspension: { ...suspension, blockerIds: ["other"] },
    }).outcome).toBe("invalid");
    expect(validateExecutionTransition(running(), {
      type: "execution-suspension-updated",
      executionId: "execution-1",
      suspension: { kind: "hitl", toolBatchId: "other-batch", blockerIds: ["hitl-1"] },
    }).outcome).toBe("invalid");
    expect(validateExecutionTransition(running(), resume(1)).outcome).toBe("invalid");

    state = apply(state, endSuspended(), 20);
    const terminal = endSuspended();
    expect(validateExecutionTransition(running(), terminal)).toEqual({ outcome: "duplicate" });
    const terminalEvents: ExecutionLifecycleEvent[] = [
      { ...terminal, terminalStatus: "failed" },
      suspend(1, suspension),
      { type: "execution-suspension-updated", executionId: "execution-1", suspension },
      resume(1),
    ];
    for (const event of terminalEvents) {
      expect(validateExecutionTransition(running(), event).outcome).toBe("invalid");
    }
  });
});
