import type {
  ProjectSessionInventoryItem,
  Session,
} from "../api/types";
import type { TerminalSessionExecutionRecord } from "@archcode/protocol";

export interface ProjectTodoResultSession {
  readonly sessionId: string;
}

/**
 * Selects the one authoritative Todo-bound Work Session that may own Result.
 * Discussion and Automation-origin Sessions never participate.
 */
export function selectProjectTodoResultSession(
  inventory: readonly ProjectSessionInventoryItem[],
  todoId: string,
): ProjectTodoResultSession | undefined {
  return inventory
    .filter(({ session, latestExecution }) => (
      session.source.kind === "todo"
      && session.source.todoId === todoId
      && session.source.entry === "work"
      && latestExecution?.status === "completed"
    ))
    .sort((left, right) => (
      (right.latestExecution?.endedAt ?? 0) - (left.latestExecution?.endedAt ?? 0)
      || right.session.updatedAt - left.session.updatedAt
      || left.session.sessionId.localeCompare(right.session.sessionId)
    ))
    .map(({ session }) => ({ sessionId: session.sessionId }))[0];
}

/**
 * Returns trusted final-answer blocks in provider/source order. The caller must
 * render each block independently so original whitespace remains intact.
 */
export function extractProjectTodoResultParts(
  session: Pick<Session, "executions" | "messages">,
): readonly string[] {
  const latestCompleted = session.executions
    .filter((execution): execution is TerminalSessionExecutionRecord => execution.status === "completed")
    .sort((left, right) => right.endedAt - left.endedAt || left.id.localeCompare(right.id))[0];
  const finalOutputStepId = latestCompleted?.finalOutputStepId;
  if (finalOutputStepId === undefined) return [];

  const finalMessage = session.messages.find((message) => (
    message.role === "assistant"
    && message.stepId === finalOutputStepId
    && message.outputPhase === "final_answer"
  ));
  if (finalMessage?.role !== "assistant") return [];

  return finalMessage.parts.flatMap((part) => (
    part.type === "assistant-output"
    && part.text.trim().length > 0
    && part.meta?.interrupted !== true
    && part.meta?.discardedFromContext !== true
      ? [part.text]
      : []
  ));
}
