import {
  TOOL_ASK_USER,
  TOOL_AST_GREP_SEARCH,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_FILE_READ,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GLOB,
  TOOL_GOAL_RETRY,
  TOOL_GOAL_RUN,
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

export function createGoalBootstrapPermission(): ToolPermission {
  return async (_input: unknown, ctx: ToolExecutionContext): Promise<PermissionDecision> => {
    const state = ctx.store.getState();
    if (state.sessionRole !== "main" || !state.goalId) return { outcome: "allow" };

    const goal = await ctx.projectContext.goalState.read(state.goalId);
    if (goal.status === "running") return { outcome: "allow" };
    if (SAFE_BOOTSTRAP_TOOLS.has(ctx.toolName)) return { outcome: "allow" };

    const expectedTool = goal.status === "failed" ? TOOL_GOAL_RETRY : TOOL_GOAL_RUN;
    if ((goal.status === "locked" || goal.status === "paused" || goal.status === "failed") && ctx.toolName === expectedTool) {
      return { outcome: "allow" };
    }

    return {
      outcome: "deny",
      reason: `Goal main session ${state.sessionId} must claim Goal ${goal.id} with ${expectedTool} before using ${ctx.toolName}`,
      errorKind: "permission-denied",
      errorCode: "GOAL_BOOTSTRAP_TOOL_DENIED",
      source: "tool-guard",
    };
  };
}
