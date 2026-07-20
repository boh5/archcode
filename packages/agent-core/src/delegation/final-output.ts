import type { SessionExecutionRecord } from "@archcode/protocol";
import type { SessionStoreState } from "../store/types";

/**
 * Returns the final assistant text for one completed execution only.
 * No other execution, including an earlier successful run, is a fallback.
 */
export function finalOutputForExecution(
  state: Pick<SessionStoreState, "executions" | "messages">,
  executionId: string,
): string | undefined {
  const execution = state.executions.find((candidate) => candidate.id === executionId);
  if (execution?.status !== "completed") return undefined;

  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message?.role !== "assistant" || message.executionId !== executionId) continue;
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

export function latestExecution(
  state: Pick<SessionStoreState, "executions">,
): SessionExecutionRecord | undefined {
  return state.executions.at(-1);
}
