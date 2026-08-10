import { describe, expect, test } from "bun:test";
import type {
  ExecutionModelBindingSummary,
  SessionExecutionRecord,
} from "@archcode/protocol";
import {
  executionVisualKind,
  presentExecutionStatus,
} from "./execution-status-presentation";

const binding: ExecutionModelBindingSummary = {
  selection: { model: "local:test" },
  providerId: "local",
  modelId: "test",
  providerDisplayName: "Local",
  modelDisplayName: "Test",
  resolution: "profile_default",
  modelRuntimeRevision: "r1",
};
const memoryPolicy = {
  policy: { useMemory: true, autoLearning: true },
  epoch: { bootId: "test-memory-boot", generation: 0 },
};
function record(
  status: SessionExecutionRecord["status"],
  suspension?: Extract<
    SessionExecutionRecord,
    { status: "suspended" }
  >["suspension"],
): SessionExecutionRecord {
  const base = {
    id: "execution",
    startedAt: 0,
    origin: "user_message" as const,
    maxSteps: 10,
    executionSkills: [],
    memoryPolicy,
    durationMs: 0,
    runs: status === "running" ? [{ ordinal: 0, startedAt: 0, binding }] : [],
  };
  if (status === "running")
    return { ...base, status } as SessionExecutionRecord;
  if (status === "suspended")
    return {
      ...base,
      status,
      suspension: suspension!,
    } as SessionExecutionRecord;
  return {
    ...base,
    status,
    endedAt: 1,
    terminalSettlement: { key: "terminal", goalInstanceId: null },
  } as SessionExecutionRecord;
}

describe("execution status presentation", () => {
  test("presents durable suspended causes without checkpoint stitching", () => {
    expect(
      presentExecutionStatus(
        record("suspended", {
          kind: "hitl",
          toolBatchId: "batch",
          blockerIds: ["hitl"],
        }),
      ),
    ).toMatchObject({ productStatus: "needs_you", label: "Needs you" });
    expect(
      presentExecutionStatus(
        record("suspended", {
          kind: "child_dependency",
          toolBatchId: "batch",
          toolCallId: "call",
          childSessionId: "child",
          childExecutionId: "child-execution",
        }),
      ),
    ).toMatchObject({
      productStatus: "waiting_on_child",
      label: "Waiting on child",
    });
    expect(
      presentExecutionStatus(
        record("suspended", {
          kind: "resume_pending",
          toolBatchId: "batch",
          readyAt: 1,
        }),
      ),
    ).toMatchObject({ productStatus: "resuming", label: "Resuming" });
  });

  test("keeps terminal failures distinct in visual semantics", () => {
    expect(presentExecutionStatus(record("completed"))).toMatchObject({
      productStatus: "completed",
    });
    expect(executionVisualKind(record("failed"))).toBe("failed");
    expect(executionVisualKind(record("cancelled"))).toBe("stopped");
  });
});
