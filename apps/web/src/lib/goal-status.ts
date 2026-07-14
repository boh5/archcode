import type { GoalStatus } from "@archcode/protocol";

/** Canonical badge classes for Goal statuses used by the primary Goal views. */
export const GOAL_STATUS_BADGE_CLASSES: Record<GoalStatus, string> = {
  running: "bg-success-muted text-success",
  reviewing: "bg-info-muted text-info",
  done: "bg-accent-muted text-accent",
  not_done: "bg-error-muted text-error",
  failed: "bg-error-muted text-error",
  cancelled: "bg-bg-active text-text-muted",
};

export function getGoalStatusBadgeClass(status: GoalStatus): string {
  return GOAL_STATUS_BADGE_CLASSES[status];
}
