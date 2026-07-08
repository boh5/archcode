import type { GoalDoneResult, GoalState } from "@archcode/protocol";

import {
  GoalArtifactNameError,
  GoalArtifactPathError,
  GoalArtifactPlanLockedError,
  GoalArtifactSecretError,
} from "../../../goals/artifacts";
import {
  GoalInvalidIdError,
  GoalLockedError,
  GoalNotFoundError,
  GoalPathError,
  GoalStateError,
} from "../../../goals/state";
import {
  GoalReviewerAuthorizationError,
  GoalRunner,
  GoalRunnerError,
} from "../../../goals/runner";
import { createToolErrorResult } from "../../errors";
import type { ToolErrorKind } from "../../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import type { SessionRole } from "../../../store/types";

export type GoalManageAction = "create" | "lock" | "start" | "advance_phase" | "retry" | "finalize_review";

export type GoalToolAuthorizationCode =
  | "GOAL_CONTEXT_REQUIRED"
  | "GOAL_MANAGE_ACTION_DENIED"
  | "GOAL_REVIEWER_REQUIRED"
  | "GOAL_ARTIFACT_WRONG_SESSION"
  | "GOAL_ARTIFACT_ROLE_DENIED"
  | "GOAL_ARTIFACT_PHASE_DENIED";

export interface GoalToolAuthorizationContext {
  readonly sessionId: string;
  readonly agentName?: string;
  readonly sessionRole?: SessionRole;
  readonly sessionGoalId?: string;
}

export interface GoalToolErrorMappingOptions {
  readonly runnerErrorCode?: "GOAL_INVALID_TRANSITION" | "GOAL_REVIEW_PHASE_REQUIRED";
  readonly stateErrorCode?: "GOAL_INVALID_TRANSITION" | "GOAL_INVALID_STATE";
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

export function createGoalRunnerFromContext(ctx: ToolExecutionContext): GoalRunner {
  const currentSession = ctx.store.getState();
  return new GoalRunner({
    goalStateManager: ctx.projectContext.goalState,
    goalArtifacts: ctx.projectContext.goalArtifacts,
    hitlService: ctx.projectContext.hitl,
    workspaceRoot: ctx.workspaceRoot,
    createSession: async (options) => {
      if (currentSession.sessionRole === "review") {
        return (await ctx.storeManager.createSessionFile(ctx.workspaceRoot, options)).sessionId;
      }
      return currentSession.sessionId;
    },
  });
}

export function formatGoalResult(goal: GoalState): string {
  return formatGoalToolResult(goal);
}

export function formatDoneResult(result: GoalDoneResult): string {
  return formatGoalToolResult(result);
}

export function formatGoalToolResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function extractGoalToolAuthorization(ctx: ToolExecutionContext): GoalToolAuthorizationContext {
  const state = ctx.store.getState();
  return {
    sessionId: state.sessionId,
    agentName: ctx.agentName ?? state.agentName,
    sessionRole: state.sessionRole,
    sessionGoalId: state.goalId,
  };
}

export function assertGoalManageActionAuthorized(
  action: GoalManageAction,
  ctx: ToolExecutionContext,
  goal?: Pick<GoalState, "id" | "reviewerAgent">,
): GoalToolAuthorizationContext {
  const authorization = extractGoalToolAuthorization(ctx);
  if (action === "finalize_review") {
    assertGoalManageReviewerActionAuthorized(action, authorization, goal);
    return authorization;
  }

  if (authorization.agentName !== "orchestrator" || authorization.sessionRole !== "main") {
    throw new GoalToolAuthorizationError(
      "GOAL_MANAGE_ACTION_DENIED",
      `goal_manage.${action} requires an orchestrator main session, got ${authorization.agentName ?? "unknown"}/${authorization.sessionRole ?? "unknown"}`,
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
  if (error instanceof GoalToolAuthorizationError || error instanceof GoalReviewerAuthorizationError) {
    return goalError("permission-denied", error.code, error.message);
  }
  if (error instanceof GoalArtifactPlanLockedError) {
    return goalError("permission-denied", "GOAL_ARTIFACT_PLAN_LOCKED", error.message);
  }
  if (error instanceof GoalArtifactSecretError) {
    return goalError("permission-denied", "GOAL_ARTIFACT_SECRET_DETECTED", error.message);
  }
  if (error instanceof GoalArtifactNameError) {
    return goalWorkspaceError("GOAL_ARTIFACT_INVALID_NAME", error.message);
  }
  if (error instanceof GoalPathError || error instanceof GoalInvalidIdError || error instanceof GoalArtifactPathError) {
    return goalWorkspaceError("GOAL_INVALID_ID", error.message);
  }
  if (error instanceof GoalRunnerError) {
    return goalWorkspaceError(options.runnerErrorCode ?? "GOAL_INVALID_TRANSITION", error.message);
  }
  if (error instanceof GoalStateError || error instanceof GoalLockedError) {
    return goalWorkspaceError(options.stateErrorCode ?? "GOAL_INVALID_TRANSITION", error.message);
  }
  return createToolErrorResult({ kind: "execution", error: error instanceof Error ? error : new Error(String(error)) });
}

function assertGoalManageReviewerActionAuthorized(
  action: GoalManageAction,
  authorization: GoalToolAuthorizationContext,
  goal: Pick<GoalState, "id" | "reviewerAgent"> | undefined,
): void {
  if (!goal) {
    throw new GoalToolAuthorizationError(
      "GOAL_CONTEXT_REQUIRED",
      `goal_manage.${action} requires the target Goal before reviewer authorization can be checked`,
    );
  }
  if (authorization.agentName !== goal.reviewerAgent) {
    throw new GoalToolAuthorizationError(
      "GOAL_REVIEWER_REQUIRED",
      `goal_manage.${action} requires reviewer agent ${goal.reviewerAgent}, got ${authorization.agentName ?? "unknown"}`,
    );
  }
  if (authorization.sessionRole !== "review") {
    throw new GoalToolAuthorizationError(
      "GOAL_REVIEWER_REQUIRED",
      `goal_manage.${action} requires a review session, got ${authorization.sessionRole ?? "unknown"}`,
    );
  }
  if (authorization.sessionGoalId !== goal.id) {
    throw new GoalToolAuthorizationError(
      "GOAL_REVIEWER_REQUIRED",
      `goal_manage.${action} requires matching session goal ${goal.id}, got ${authorization.sessionGoalId ?? "unknown"}`,
    );
  }
}

function goalWorkspaceError(code: string, message: string): ToolExecutionResult {
  return goalError("workspace", code, message);
}

function goalError(kind: ToolErrorKind, code: string, message: string): ToolExecutionResult {
  return createToolErrorResult({ kind, code, message });
}
