import {
  TOOL_ASK_USER,
  TOOL_AST_GREP_SEARCH,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_DELEGATE,
  TOOL_FILE_READ,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GLOB,
  TOOL_GOAL_MANAGE,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_SYMBOLS,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_WEB_FETCH,
} from "@archcode/protocol";

import type { PermissionDecision, ToolExecutionContext, ToolPermission } from "../types";

const SAFE_BOOTSTRAP_TOOLS = new Set<string>([
  TOOL_FILE_READ,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_AST_GREP_SEARCH,
  TOOL_GIT_STATUS,
  TOOL_GIT_DIFF,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_SYMBOLS,
  TOOL_WEB_FETCH,
  TOOL_ASK_USER,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_VIEW_TOOL_OUTPUT,
]);

const REVIEWING_GOAL_MANAGE_ACTIONS = new Set<string>(["block", "cancel"]);

export function createGoalBootstrapPermission(): ToolPermission {
  return async (input: unknown, ctx: ToolExecutionContext): Promise<PermissionDecision> => {
    const state = ctx.store.getState();
    if (state.sessionRole !== "main" || !state.goalId) return { outcome: "allow" };

    const goal = await ctx.projectContext.goalState.read(state.goalId);
    if (goal.status === "running") return { outcome: "allow" };
    if (goal.status === "reviewing" && goal.mainSessionId === state.sessionId) {
      if (ctx.toolName === TOOL_DELEGATE && getDelegateAgentType(input) === "reviewer") {
        return { outcome: "allow" };
      }
      if (ctx.toolName === TOOL_GOAL_MANAGE && REVIEWING_GOAL_MANAGE_ACTIONS.has(getGoalManageAction(input) ?? "")) {
        return { outcome: "allow" };
      }
    }
    if (SAFE_BOOTSTRAP_TOOLS.has(ctx.toolName)) return { outcome: "allow" };

    const expectedAction = goal.status === "failed" || goal.status === "not_done" ? "retry" : "start";
    if (
      (goal.status === "draft" || goal.status === "blocked" || goal.status === "failed" || goal.status === "not_done")
      && ctx.toolName === TOOL_GOAL_MANAGE
      && getGoalManageAction(input) === expectedAction
    ) {
      return { outcome: "allow" };
    }

    return {
      outcome: "deny",
      reason: `Goal main session ${state.sessionId} must claim Goal ${goal.id} with ${TOOL_GOAL_MANAGE}.${expectedAction} before using ${ctx.toolName}`,
      errorKind: "permission-denied",
      errorCode: "GOAL_BOOTSTRAP_TOOL_DENIED",
      source: "tool-guard",
    };
  };
}

function getDelegateAgentType(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("agent_type" in input)) return undefined;
  const agentType = (input as { agent_type?: unknown }).agent_type;
  return typeof agentType === "string" ? agentType : undefined;
}

function getGoalManageAction(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("action" in input)) return undefined;
  const action = (input as { action?: unknown }).action;
  return typeof action === "string" ? action : undefined;
}
