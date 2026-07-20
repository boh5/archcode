import { createToolErrorResult } from "./errors";
import type {
  RawToolResult,
  StructuredResultCorrectionGate,
} from "./types";
import type { SessionStoreState } from "../store/types";

export type StructuredResultSubmission = StructuredResultCorrectionGate["submission"];

const SUBMISSION_COPY: Record<StructuredResultSubmission, {
  readonly label: string;
  readonly tool: string;
}> = {
  submit_child_result: {
    label: "Canonical child result",
    tool: "submit_child_result",
  },
};

export function createStructuredResultCorrectionGate(
  initialFailures = 0,
  submission: StructuredResultSubmission = "submit_child_result",
): StructuredResultCorrectionGate {
  let failures = initialFailures;
  const copy = SUBMISSION_COPY[submission];
  return {
    submission,
    recordFailure(error: Error): RawToolResult {
      failures += 1;
      const terminate = failures > 1;
      const result = createToolErrorResult({
        kind: "execution",
        code: terminate
          ? "CHILD_RESULT_REQUIRED"
          : "STRUCTURED_RESULT_CORRECTION_REQUIRED",
        name: error.name,
        message: terminate
          ? `${copy.label} rejected: ${error.message}`
          : `${copy.label} rejected; one structured correction remains: ${error.message}`,
        hint: terminate
          ? `The child Execution is terminating without a valid result; free text cannot replace ${copy.tool}.`
          : `Retry ${copy.tool} once with schema-valid input that exactly satisfies the durable delegation contract.`,
        error,
      });
      if (!terminate) return result;
      return {
        ...result,
        sidecar: {
          ...result.sidecar,
          executionControl: {
            action: "fail_execution",
            reason: "child_result_required",
            error: "CHILD_RESULT_REQUIRED: " + error.message,
          },
        },
      };
    },
  };
}

export function countStructuredResultFailures(
  state: Pick<SessionStoreState, "currentExecutionId" | "executions" | "toolBatches">,
  submission: StructuredResultSubmission = "submit_child_result",
): number {
  const executionId = state.currentExecutionId;
  if (executionId === undefined) return 0;
  const lineageExecutionIds = new Set([executionId]);
  let currentExecutionIndex = -1;
  for (let index = state.executions.length - 1; index >= 0; index -= 1) {
    if (state.executions[index]?.id !== executionId) continue;
    currentExecutionIndex = index;
    break;
  }
  if (currentExecutionIndex >= 0 && state.executions[currentExecutionIndex]?.origin === "tool_batch") {
    for (let index = currentExecutionIndex - 1; index >= 0; index -= 1) {
      const execution = state.executions[index];
      if (execution === undefined) continue;
      lineageExecutionIds.add(execution.id);
      if (execution.origin !== "tool_batch") break;
    }
  }
  let failures = 0;
  for (const batch of state.toolBatches) {
    if (!lineageExecutionIds.has(batch.executionId)) continue;
    for (const call of batch.calls) {
      if (!isStructuredResultSubmission(call.toolName, call.input, submission) || call.result?.isError !== true) continue;
      const code = toolErrorCode(call.result.output.preview);
      if (
        code === "STRUCTURED_RESULT_CORRECTION_REQUIRED"
        || code === "CHILD_RESULT_REQUIRED"
      ) failures += 1;
    }
  }
  return failures;
}

export function isStructuredResultSubmission(
  toolName: string,
  input: unknown,
  submission: StructuredResultSubmission,
): boolean {
  return toolName === "submit_child_result";
}

function toolErrorCode(output: string): string | undefined {
  try {
    const value = JSON.parse(output) as { code?: unknown };
    return typeof value.code === "string" ? value.code : undefined;
  } catch {
    return undefined;
  }
}
