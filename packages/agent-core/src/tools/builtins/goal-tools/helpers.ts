import type { GoalState } from "@archcode/protocol";

import {
  GoalInvalidIdError,
  GoalNotFoundError,
  GoalPathError,
  GoalReviewFinalizationError,
  GoalReviewerAuthorizationError,
  GoalStateError,
  GoalTransitionError,
} from "../../../goals/state";
import { createToolErrorResult } from "../../errors";
import type { ToolErrorKind } from "../../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import type { SessionRole } from "../../../store/types";

export type GoalManageAction =
  | "block"
  | "resume"
  | "begin_review"
  | "finalize_review"
  | "retry"
  | "cancel";

export type GoalToolAuthorizationCode =
  | "GOAL_CONTEXT_REQUIRED"
  | "GOAL_CREATE_DENIED"
  | "GOAL_MANAGE_ACTION_DENIED"
  | "GOAL_REVIEWER_REQUIRED"
  | "GOAL_CANCELLATION_UNAVAILABLE"
  | "GOAL_WORKTREE_REQUIRED"
  | "GOAL_WORKTREE_MISMATCH"
  | "GOAL_WORKTREE_CHANGED"
  | "GOAL_BUILD_ACTIVE";

export interface GoalToolAuthorizationContext {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly agentName?: string;
  readonly sessionRole?: SessionRole;
  readonly sessionGoalId?: string;
  readonly sessionLoopId?: string;
}

export interface GoalToolErrorMappingOptions {
  readonly stateErrorCode?: "GOAL_INVALID_TRANSITION" | "GOAL_INVALID_STATE" | "GOAL_REVIEW_PHASE_REQUIRED";
}

export class GoalToolAuthorizationError extends Error {
  constructor(
    public readonly code: GoalToolAuthorizationCode,
    message: string,
  ) {
    super(message);
    this.name = "GoalToolAuthorizationError";
  }
}

export function formatGoalToolResult(value: GoalState): string {
  return JSON.stringify(value, null, 2);
}

export function extractGoalToolAuthorization(ctx: ToolExecutionContext): GoalToolAuthorizationContext {
  const state = ctx.store.getState();
  return {
    sessionId: state.sessionId,
    rootSessionId: state.rootSessionId,
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    agentName: ctx.agentName ?? state.agentName,
    sessionRole: state.sessionRole,
    sessionGoalId: state.goalId,
    ...(state.loopId === undefined ? {} : { sessionLoopId: state.loopId }),
  };
}

/** Goal drafts may only originate from an unbound interactive Engineer root Session. */
export function assertGoalCreateAuthorized(ctx: ToolExecutionContext): GoalToolAuthorizationContext {
  const authorization = extractGoalToolAuthorization(ctx);
  const isOrdinaryRoot = authorization.sessionId === authorization.rootSessionId
    && authorization.parentSessionId === undefined
    && authorization.sessionRole === undefined
    && authorization.sessionGoalId === undefined
    && authorization.sessionLoopId === undefined;
  if (authorization.agentName !== "engineer" || !isOrdinaryRoot) {
    throw new GoalToolAuthorizationError(
      "GOAL_CREATE_DENIED",
      `goal_create requires an unbound engineer root session, got ${authorization.agentName ?? "unknown"}/${authorization.sessionRole ?? "none"}`,
    );
  }
  return authorization;
}

export function assertGoalManageActionAuthorized(
  action: GoalManageAction,
  ctx: ToolExecutionContext,
  goalId?: string,
): GoalToolAuthorizationContext {
  const authorization = extractGoalToolAuthorization(ctx);
  if (action === "finalize_review") {
    assertReviewerFinalizationAuthorized(action, authorization, goalId);
    return authorization;
  }

  if (authorization.agentName !== "goal_lead" || authorization.sessionRole !== "main") {
    throw new GoalToolAuthorizationError(
      "GOAL_MANAGE_ACTION_DENIED",
      `goal_manage.${action} requires a goal_lead main session, got ${authorization.agentName ?? "unknown"}/${authorization.sessionRole ?? "unknown"}`,
    );
  }
  if (authorization.sessionGoalId !== goalId) {
    throw new GoalToolAuthorizationError(
      "GOAL_CONTEXT_REQUIRED",
      `goal_manage.${action} requires matching session goal ${goalId ?? "unknown"}, got ${authorization.sessionGoalId ?? "unknown"}`,
    );
  }
  return authorization;
}

export function goalToolErrorResult(
  error: unknown,
  options: GoalToolErrorMappingOptions = {},
): ToolExecutionResult {
  if (error instanceof GoalNotFoundError) {
    return goalWorkspaceError("GOAL_NOT_FOUND", error.message);
  }
  if (error instanceof GoalToolAuthorizationError) {
    return goalError("permission-denied", error.code, error.message);
  }
  if (error instanceof GoalPathError || error instanceof GoalInvalidIdError) {
    return goalWorkspaceError("GOAL_INVALID_ID", error.message);
  }
  if (error instanceof GoalReviewerAuthorizationError) {
    return goalError("permission-denied", error.code, error.message);
  }
  if (error instanceof GoalStateError || error instanceof GoalTransitionError || error instanceof GoalReviewFinalizationError) {
    return goalWorkspaceError(options.stateErrorCode ?? "GOAL_INVALID_TRANSITION", error.message);
  }
  if (error instanceof Error && error.name === "GoalRunnerError") {
    return goalWorkspaceError(options.stateErrorCode ?? "GOAL_INVALID_TRANSITION", error.message);
  }
  return createToolErrorResult({ kind: "execution", error: error instanceof Error ? error : new Error(String(error)) });
}

function assertReviewerFinalizationAuthorized(
  action: GoalManageAction,
  authorization: GoalToolAuthorizationContext,
  goalId: string | undefined,
): void {
  if (!goalId) {
    throw new GoalToolAuthorizationError(
      "GOAL_CONTEXT_REQUIRED",
      `goal_manage.${action} requires the target Goal before reviewer authorization can be checked`,
    );
  }
  if (authorization.agentName !== "reviewer") {
    throw new GoalToolAuthorizationError(
      "GOAL_REVIEWER_REQUIRED",
      `goal_manage.${action} requires reviewer agent, got ${authorization.agentName ?? "unknown"}`,
    );
  }
  if (authorization.sessionRole !== "review") {
    throw new GoalToolAuthorizationError(
      "GOAL_REVIEWER_REQUIRED",
      `goal_manage.${action} requires a review session, got ${authorization.sessionRole ?? "unknown"}`,
    );
  }
  if (authorization.sessionGoalId !== goalId) {
    throw new GoalToolAuthorizationError(
      "GOAL_REVIEWER_REQUIRED",
      `goal_manage.${action} requires matching session goal ${goalId}, got ${authorization.sessionGoalId ?? "unknown"}`,
    );
  }
}

function goalWorkspaceError(code: string, message: string): ToolExecutionResult {
  return goalError("workspace", code, message);
}

function goalError(kind: ToolErrorKind, code: string, message: string): ToolExecutionResult {
  return createToolErrorResult({ kind, code, message });
}
