import type { GoalStatus } from "@archcode/protocol";

export type GoalExecutionAction = "start" | "retry";
export type GoalExecutionStatusEligibility = "proceed" | "running_claim" | "reject";

/**
 * Pure Goal-domain policy for execution entry points. Resource orchestration
 * must evaluate this before preparing a workspace or creating a Session.
 * A running claim needs entry-point-specific identity/activity validation and
 * is never a second lifecycle transition.
 */
export function goalExecutionStatusEligibility(
  action: GoalExecutionAction,
  status: GoalStatus,
): GoalExecutionStatusEligibility {
  if (status === "running") return "running_claim";
  if (action === "start") return status === "draft" ? "proceed" : "reject";
  return status === "not_done" || status === "failed" ? "proceed" : "reject";
}
