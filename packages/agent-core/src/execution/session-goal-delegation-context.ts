import type { GoalState } from "@archcode/protocol";

export interface SessionGoalDelegationContext {
  readonly goalId: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly status: GoalState["status"];
  readonly attempt: number;
  readonly reviewGeneration: number;
  readonly lastFailureSummary: string | null;
}

export function sessionGoalDelegationContext(goal: GoalState): SessionGoalDelegationContext {
  return {
    goalId: goal.id,
    objective: goal.objective,
    acceptanceCriteria: goal.acceptanceCriteria,
    status: goal.status,
    attempt: goal.attempt,
    reviewGeneration: goal.reviewGeneration,
    lastFailureSummary: goal.lastFailureSummary ?? null,
  };
}

export function prependSessionGoalDelegationContext(
  prompt: string,
  context: SessionGoalDelegationContext | undefined,
): string {
  if (context === undefined) return prompt;
  return `<goal-delegation-context>\nThis is the latest persisted snapshot of the Goal that owns this delegated session. Treat it as authoritative for the delegated work.\n${JSON.stringify(context, null, 2)}\n</goal-delegation-context>\n\n${prompt}`;
}
