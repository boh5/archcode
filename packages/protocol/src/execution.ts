import type {
  ExecutionEndEvent,
  ExecutionLifecycleEvent,
  ExecutionResumedEvent,
  ExecutionStartEvent,
  ExecutionSuspendedEvent,
  ExecutionSuspensionUpdatedEvent,
  ExecutionTransitionValidation,
  SessionExecutionRecord,
  SessionExecutionSuspension,
} from "./types";

const TERMINAL_STATUSES = new Set([
  "completed",
  "max_steps",
  "failed",
  "aborted",
  "cancelled",
  "timed_out",
  "interrupted",
]);

export function validateExecutionTransition(
  executions: readonly SessionExecutionRecord[],
  event: ExecutionLifecycleEvent,
): ExecutionTransitionValidation {
  const execution = executions.find((candidate) => candidate.id === event.executionId);

  switch (event.type) {
    case "execution-start":
      return validateStart(executions, execution, event);
    case "execution-suspended":
      return validateSuspend(execution, event);
    case "execution-suspension-updated":
      return validateSuspensionUpdate(execution, event);
    case "execution-resumed":
      return validateResume(execution, event);
    case "execution-end":
      return validateEnd(execution, event);
  }
}

export function isExecutionTerminalStatus(value: string): boolean {
  return TERMINAL_STATUSES.has(value);
}

function validateStart(
  executions: readonly SessionExecutionRecord[],
  execution: SessionExecutionRecord | undefined,
  event: ExecutionStartEvent,
): ExecutionTransitionValidation {
  if (execution !== undefined) {
    const firstRun = execution.runs[0];
    return firstRun !== undefined
      && execution.origin === event.origin
      && execution.maxSteps === event.maxSteps
      && execution.activeTimeoutMs === event.activeTimeoutMs
      && equal(firstRun.binding, event.binding)
      ? duplicate()
      : invalid(`Execution ${event.executionId} already exists with a conflicting start`);
  }
  if (executions.some((candidate) => !isExecutionTerminalStatus(candidate.status))) {
    return invalid("A Session may have at most one nonterminal Execution");
  }
  return valid();
}

function validateSuspend(
  execution: SessionExecutionRecord | undefined,
  event: ExecutionSuspendedEvent,
): ExecutionTransitionValidation {
  if (execution === undefined) return invalid(`Execution ${event.executionId} does not exist`);
  if (execution.status === "suspended") {
    const lastRun = execution.runs.at(-1);
    return lastRun?.endedAt === event.runEndedAt
      && equal(lastRun.usageDelta, event.runUsageDelta)
      && settlementMatches(lastRun.settlement, event.runSettlement)
      && equal(execution.suspension, event.suspension)
      ? duplicate()
      : invalid(`Execution ${event.executionId} is already suspended`);
  }
  if (execution.status !== "running") {
    return invalid(`Execution ${event.executionId} is terminal`);
  }
  if (event.suspension.kind === "resume_pending") {
    return invalid("A running Execution cannot suspend directly as resume_pending");
  }
  const run = execution.runs.at(-1);
  if (run === undefined || run.endedAt !== undefined) {
    return invalid(`Execution ${event.executionId} has no open run`);
  }
  if (event.runEndedAt < run.startedAt) {
    return invalid("runEndedAt precedes the active run");
  }
  return valid();
}

function validateSuspensionUpdate(
  execution: SessionExecutionRecord | undefined,
  event: ExecutionSuspensionUpdatedEvent,
): ExecutionTransitionValidation {
  if (execution === undefined) return invalid(`Execution ${event.executionId} does not exist`);
  if (execution.status !== "suspended") {
    return invalid(`Execution ${event.executionId} is not suspended`);
  }
  if (equal(execution.suspension, event.suspension)) return duplicate();
  if (execution.suspension.kind === "resume_pending") {
    return invalid("A resume-pending suspension cannot be updated");
  }
  if (execution.suspension.toolBatchId !== event.suspension.toolBatchId) {
    return invalid("A suspension update cannot change its Tool Batch");
  }
  if (event.suspension.kind === "resume_pending") return valid();
  if (execution.suspension.kind === "hitl" && event.suspension.kind === "hitl") return valid();
  return invalid(`Invalid suspension update from ${execution.suspension.kind} to ${event.suspension.kind}`);
}

function validateResume(
  execution: SessionExecutionRecord | undefined,
  event: ExecutionResumedEvent,
): ExecutionTransitionValidation {
  if (execution === undefined) return invalid(`Execution ${event.executionId} does not exist`);
  if (execution.status === "running") {
    const run = execution.runs.at(-1);
    return execution.runs.length > 1
      && run !== undefined
      && run.endedAt === undefined
      && run.ordinal === event.runOrdinal
      && equal(run.binding, event.binding)
      ? duplicate()
      : invalid(`Execution ${event.executionId} is already running`);
  }
  if (execution.status !== "suspended") {
    return invalid(`Execution ${event.executionId} is terminal`);
  }
  if (execution.suspension.kind !== "resume_pending") {
    return invalid(`Execution ${event.executionId} is not ready to resume`);
  }
  if (event.runOrdinal !== execution.runs.length) {
    return invalid(
      `Execution ${event.executionId} expected resume run ${execution.runs.length}, received ${event.runOrdinal}`,
    );
  }
  return valid();
}

function validateEnd(
  execution: SessionExecutionRecord | undefined,
  event: ExecutionEndEvent,
): ExecutionTransitionValidation {
  if (execution === undefined) return invalid(`Execution ${event.executionId} does not exist`);
  if (isExecutionTerminalStatus(execution.status)) {
    const run = execution.runs.at(-1);
    const sameRunClose = event.runEndedAt === undefined
      ? event.runUsageDelta === undefined && event.runSettlement === undefined
      : event.runSettlement !== undefined
        && run?.endedAt === event.runEndedAt
        && equal(run.usageDelta, event.runUsageDelta)
        && settlementMatches(run.settlement, event.runSettlement);
    return execution.status === event.terminalStatus
      && execution.endedAt === event.endedAt
      && execution.error === event.error
      && settlementMatches(execution.terminalSettlement, event.terminalSettlement)
      && sameRunClose
      ? duplicate()
      : invalid(`Execution ${event.executionId} is already terminal`);
  }
  if (execution.status === "running") {
    if (event.runEndedAt === undefined
      || event.runUsageDelta === undefined
      || event.runSettlement === undefined) {
      return invalid("Ending a running Execution must close its active run");
    }
    const run = execution.runs.at(-1);
    if (run === undefined || run.endedAt !== undefined) {
      return invalid(`Execution ${event.executionId} has no open run`);
    }
    if (event.runEndedAt < run.startedAt || event.endedAt < event.runEndedAt) {
      return invalid("Execution end times are outside the active run");
    }
    return valid();
  }
  if (event.runEndedAt !== undefined
    || event.runUsageDelta !== undefined
    || event.runSettlement !== undefined) {
    return invalid("Ending a suspended Execution cannot close a run");
  }
  const lastRun = execution.runs.at(-1);
  if (lastRun !== undefined && lastRun.endedAt !== undefined && event.endedAt < lastRun.endedAt) {
    return invalid("endedAt precedes the last closed run");
  }
  return valid();
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equal(value, right[index]));
  }
  if (typeof left !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && equal(leftRecord[key], rightRecord[key])
    );
}

function settlementMatches(
  persisted: { key: string; goalInstanceId: string | null },
  input: { key: string; goalInstanceId: string | null },
): boolean {
  return persisted.key === input.key && persisted.goalInstanceId === input.goalInstanceId;
}

function valid(): ExecutionTransitionValidation {
  return { outcome: "valid" };
}

function duplicate(): ExecutionTransitionValidation {
  return { outcome: "duplicate" };
}

function invalid(reason: string): ExecutionTransitionValidation {
  return { outcome: "invalid", reason };
}
