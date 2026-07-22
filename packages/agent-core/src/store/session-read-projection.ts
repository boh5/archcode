import type {
  CompressionStateSnapshot,
  SessionExecutionInputCheckpoint,
  SessionExecutionRecord,
} from "@archcode/protocol";
import { compressionStateSnapshot } from "../compression/dynamic-range";
import type { CompressionState } from "../compression";
import type { SessionToolBatch } from "./types";

/**
 * Converts the persisted runtime compression model into the public Session
 * read projection. Persistence keeps the structured summary while the Web
 * boundary receives the rendered authoritative Protocol snapshot.
 */
export function projectSessionCompression(
  state: CompressionState,
): CompressionStateSnapshot {
  return compressionStateSnapshot(state);
}

/**
 * Joins the immutable Execution end reason with its durable tool-batch
 * continuation facts. This is intentionally a read projection: answering a
 * request never rewrites the historical Execution record.
 */
export function projectSessionExecutionInputCheckpoints(
  executions: readonly SessionExecutionRecord[],
  toolBatches: readonly SessionToolBatch[],
): SessionExecutionInputCheckpoint[] {
  const indexByExecutionId = new Map(executions.map((execution, index) => [execution.id, index]));

  return toolBatches.flatMap((batch) => {
    const sourceIndex = indexByExecutionId.get(batch.executionId);
    const sourceExecution = sourceIndex === undefined ? undefined : executions[sourceIndex];
    if (sourceIndex === undefined || sourceExecution?.status !== "waiting_for_human") return [];

    const checkpointCalls = batch.calls.filter((call) => call.blocker !== undefined);
    if (checkpointCalls.length === 0) return [];

    const continuationExecution = batch.continuationStartedAt === undefined
      ? undefined
      : executions.slice(sourceIndex + 1).find((execution) => execution.origin === "tool_batch");
    const cancelled = checkpointCalls.some((call) => call.blocker?.response?.type === "cancel");
    const hasPendingResponse = checkpointCalls.some(
      (call) => call.state === "blocked" && call.blocker?.responseAppliedAt === undefined,
    );
    const hasResponse = checkpointCalls.some((call) => call.blocker?.responseAppliedAt !== undefined);

    const state: SessionExecutionInputCheckpoint["state"] = cancelled
      ? "cancelled"
      : continuationExecution !== undefined
        ? continuationExecution.status === "running" ? "continuing" : "continued"
        : batch.continuationCompletedAt !== undefined
          ? "continued"
          : batch.continuationStartedAt !== undefined
            ? "continuing"
            : hasPendingResponse
              ? "pending_response"
              : hasResponse
                ? "response_received"
                : "pending_response";

    return [{
      executionId: sourceExecution.id,
      state,
      ...(continuationExecution === undefined ? {} : { continuationExecutionId: continuationExecution.id }),
    }];
  });
}
