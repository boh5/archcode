import type { PermissionDecision, ToolExecutionContext, ToolPermission } from "../tools/types";
import { TOOL_GOAL_MANAGE, TOOL_TODO_WRITE } from "../tools/names";
import { evaluateBudget, effectiveBudget, LOOP_BUDGET_EXECUTION_CONTROL, LoopBudgetLedger } from "./budget-ledger";

const SOFT_ALLOWED_EFFECTFUL_TOOLS = new Set<string>([
  TOOL_TODO_WRITE,
  TOOL_GOAL_MANAGE,
]);

export function createLoopBudgetToolPermission(): ToolPermission {
  return async (_input: unknown, ctx: ToolExecutionContext): Promise<PermissionDecision> => {
    const origin = ctx.origin;
    if (origin?.kind !== "loop") return { outcome: "allow" };
    if (!isEffectfulTool(ctx)) return { outcome: "allow" };

    const ledger = new LoopBudgetLedger({
      stateManager: ctx.projectContext.loopState,
      workspaceRoot: ctx.projectContext.project.workspaceRoot,
    });
    const loop = await ctx.projectContext.loopState.read(origin.loopId);
    const usage = loop.latestBudget?.usage;
    if (usage === undefined) return { outcome: "allow" };

    const status = evaluateBudget(effectiveBudget(loop), usage);
    if (status.level === "hard") {
      await ledger.recordHardExceeded({
        loopId: origin.loopId,
        runId: origin.runId,
        sessionId: ctx.store.getState().sessionId,
        source: `tool_guard:${ctx.toolName}`,
        summary: "Loop hard budget exceeded; effectful tool blocked and run paused.",
      });
      return {
        outcome: "deny",
        source: "tool-guard",
        ruleId: "loop.hard_budget",
        errorKind: "permission-denied",
        errorCode: "LOOP_HARD_BUDGET_EXCEEDED",
        reason: "[LOOP_HARD_BUDGET_EXCEEDED] Loop hard budget exceeded; effectful tool blocked and run paused until user action.",
        executionControl: LOOP_BUDGET_EXECUTION_CONTROL,
      };
    }

    if (status.level === "soft" && !SOFT_ALLOWED_EFFECTFUL_TOOLS.has(ctx.toolName)) {
      await ledger.recordSoftBlock(origin.loopId, origin.runId, ctx.store.getState().sessionId, `tool_guard:${ctx.toolName}`);
      return {
        outcome: "deny",
        source: "tool-guard",
        ruleId: "loop.soft_budget",
        errorKind: "permission-denied",
        errorCode: "LOOP_SOFT_BUDGET_BLOCKED",
        reason: "[LOOP_SOFT_BUDGET_BLOCKED] Loop soft budget threshold reached; use read-only diagnostics or final audit/state writes only.",
      };
    }

    return { outcome: "allow" };
  };
}

function isEffectfulTool(ctx: ToolExecutionContext): boolean {
  const traits = ctx.toolTraits;
  if (traits === undefined) return true;
  return traits.destructive || !traits.readOnly;
}
