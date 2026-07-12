import type { GoalState } from "@archcode/protocol";

import type { AgentName } from "../agents";
import type { SessionRole } from "../store/types";

export interface GoalSessionIdentity {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly parentAgentName?: AgentName;
  readonly isDescendantOfRoot?: boolean;
  readonly agentName?: AgentName;
  readonly sessionRole?: SessionRole;
}

export type GoalSessionExecutionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "reviewer_required" | "not_executable" };

export function decideGoalSessionExecution(input: {
  readonly goal: Pick<GoalState, "status" | "mainSessionId">;
  readonly subject: GoalSessionIdentity;
  readonly entryKind: "user_message" | "hitl_replay";
}): GoalSessionExecutionDecision {
  const { goal, subject } = input;
  const mainGoalLead = isMainGoalLead(goal.mainSessionId, subject);
  if (goal.status === "running") {
    return mainGoalLead || isRunningChild(subject) ? { allowed: true } : notExecutable();
  }
  if (goal.status === "reviewing") {
    return mainGoalLead || isReviewChild(subject) ? { allowed: true } : { allowed: false, reason: "reviewer_required" };
  }
  if (goal.status === "not_done" && mainGoalLead) return { allowed: true };
  if (goal.status === "blocked" && input.entryKind === "hitl_replay" && mainGoalLead) return { allowed: true };
  return notExecutable();
}

export function isGoalDelegationAllowed(input: {
  readonly goal: Pick<GoalState, "status" | "mainSessionId">;
  readonly parent: GoalSessionIdentity;
  readonly targetAgentName: AgentName;
}): boolean {
  const { goal, parent, targetAgentName } = input;
  if (!isCurrentFamilyMember(goal.mainSessionId, parent)) return false;
  if (goal.status === "running") {
    if (targetAgentName === "reviewer") return false;
    return isMainGoalLead(goal.mainSessionId, parent) || isRunningChild(parent);
  }
  if (goal.status !== "reviewing") return false;
  if (isMainGoalLead(goal.mainSessionId, parent)) return targetAgentName === "reviewer";
  return parent.agentName === "reviewer"
    && parent.sessionRole === "review"
    && (targetAgentName === "explore" || targetAgentName === "librarian");
}

function isCurrentFamilyMember(mainSessionId: string | undefined, subject: GoalSessionIdentity): boolean {
  if (mainSessionId === undefined || subject.rootSessionId !== mainSessionId) return false;
  return subject.sessionId === mainSessionId
    ? subject.parentSessionId === undefined
    : subject.parentSessionId !== undefined && subject.isDescendantOfRoot === true;
}

function isMainGoalLead(mainSessionId: string | undefined, subject: GoalSessionIdentity): boolean {
  return mainSessionId !== undefined
    && subject.sessionId === mainSessionId
    && subject.rootSessionId === mainSessionId
    && subject.parentSessionId === undefined
    && subject.sessionRole === "main"
    && subject.agentName === "goal_lead";
}

function isRunningChild(subject: GoalSessionIdentity): boolean {
  if (subject.parentSessionId === undefined || subject.isDescendantOfRoot !== true) return false;
  return (subject.agentName === "plan" && subject.sessionRole === "plan")
    || (subject.agentName === "build" && subject.sessionRole === "build")
    || (subject.agentName === "explore" && subject.sessionRole === "explore")
    || (subject.agentName === "librarian" && subject.sessionRole === "librarian");
}

function isReviewChild(subject: GoalSessionIdentity): boolean {
  if (subject.parentSessionId === undefined || subject.isDescendantOfRoot !== true) return false;
  if (subject.agentName === "reviewer" && subject.sessionRole === "review") return true;
  return subject.parentAgentName === "reviewer" && (
    (subject.agentName === "explore" && subject.sessionRole === "explore")
    || (subject.agentName === "librarian" && subject.sessionRole === "librarian")
  );
}

function notExecutable(): GoalSessionExecutionDecision {
  return { allowed: false, reason: "not_executable" };
}
