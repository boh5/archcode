import type { SessionExecutionRecord } from "@archcode/protocol";
import type { SessionStoreState } from "../store/types";

/**
 * Returns the final assistant text for one completed execution only.
 * No other execution, including an earlier successful run, is eligible.
 */
export function finalOutputForExecution(
  state: Pick<SessionStoreState, "executions" | "messages">,
  executionId: string,
): string | undefined {
  const execution = state.executions.find((candidate) => candidate.id === executionId);
  if (execution?.status !== "completed") return undefined;
  if (execution.finalOutputStepId === undefined) return "";
  const message = state.messages.find((candidate) => (
    candidate.role === "assistant"
    && candidate.executionId === executionId
    && candidate.stepId === execution.finalOutputStepId
    && candidate.outputPhase === "final_answer"
  ));
  return message?.parts
    .filter((part) => part.type === "assistant-output")
    .map((part) => part.text)
    .join("") ?? "";
}

export function latestExecution(
  state: Pick<SessionStoreState, "executions">,
): SessionExecutionRecord | undefined {
  return state.executions.at(-1);
}
