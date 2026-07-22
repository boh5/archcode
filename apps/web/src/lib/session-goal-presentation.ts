import type { SessionGoalStatus } from "@archcode/protocol";
import type { StatusTone, VisualStatusKind } from "./status-visuals";

export interface SessionGoalStatusPresentation {
  readonly label: "Active" | "Paused" | "Blocked" | "Budget limited" | "Completed";
  readonly kind?: VisualStatusKind;
  readonly tone: StatusTone;
}

const SESSION_GOAL_STATUS: Readonly<Record<SessionGoalStatus, SessionGoalStatusPresentation>> = {
  active: { label: "Active", tone: "brand" },
  paused: { label: "Paused", kind: "paused", tone: "warning" },
  blocked: { label: "Blocked", kind: "blocked", tone: "warning" },
  budget_limited: { label: "Budget limited", kind: "budget_limited", tone: "warning" },
  complete: { label: "Completed", kind: "completed", tone: "success" },
};

export function presentSessionGoalStatus(status: SessionGoalStatus): SessionGoalStatusPresentation {
  return SESSION_GOAL_STATUS[status];
}
