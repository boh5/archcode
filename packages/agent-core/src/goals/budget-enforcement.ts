import { normalizeUsage } from "@archcode/protocol";
import type { GoalBudgetSummary } from "@archcode/protocol";

import type { ModelCallOptions } from "../config/provider";
import type { ProjectHitlQueue } from "../hitl/project-queue";
import type { SessionStoreState } from "../store/types";
import { withGoalExecutionClaimLock } from "./execution-claim";
import { GOAL_BUDGET_APPROVAL_PENDING_REASON, type GoalState, type GoalStateManager } from "./state";

export const BUDGET_APPROVAL_POINT = "approval_budget_1";

export class GoalBudgetEnforcementStopError extends DOMException {
  constructor(public readonly goalId: string, message: string) {
    super(message, "AbortError");
  }
}

export interface GoalBudgetEnforcementContext {
  readonly store: { getState(): SessionStoreState };
  readonly projectContext?: GoalBudgetProjectContext;
  readonly modelOptions?: ModelCallOptions;
}

export interface GoalBudgetProjectContext {
  readonly goalState: GoalStateManager;
  readonly hitl: Pick<ProjectHitlQueue, "create">;
}

export function createGoalBudgetEnforcementHooks() {
  return {
    beforeModelCall: async (ctx: GoalBudgetEnforcementContext): Promise<void> => {
      await enforceGoalBudgetBeforeModelCall(ctx);
    },
    afterStepEnd: async (ctx: GoalBudgetEnforcementContext): Promise<void> => {
      await enforceGoalBudgetAfterStepEnd(ctx);
    },
  };
}

export async function enforceGoalBudgetBeforeModelCall(ctx: GoalBudgetEnforcementContext): Promise<void> {
  const resolved = await resolveGoalBudgetContext(ctx);
  if (resolved === undefined) return;

  const { goal: observedGoal, projectContext } = resolved;
  await withGoalExecutionClaimLock(observedGoal.id, async () => {
    const goal = await projectContext.goalState.read(observedGoal.id);
    const budget = goal.budget;
    if (budget === undefined) return;

    if (isHardExceeded(budget)) {
      await blockForHardStop(projectContext, goal, budget, "Budget hard limit exceeded");
    }

    const estimatedNextCallTokens = estimateNextModelCallTokens(ctx.modelOptions);
    if (shouldRequestWarningApproval(budget, estimatedNextCallTokens)) {
      await requestBudgetApproval(projectContext, goal, budget, estimatedNextCallTokens);
    }
  });
}

export async function enforceGoalBudgetAfterStepEnd(ctx: GoalBudgetEnforcementContext): Promise<void> {
  const resolved = await resolveGoalBudgetContext(ctx);
  if (resolved === undefined) return;
  const latestUsage = normalizeUsage(ctx.store.getState().steps.at(-1)?.usage);
  if (latestUsage.totalTokens === 0) return;
  const { goal: observedGoal, projectContext } = resolved;
  await withGoalExecutionClaimLock(observedGoal.id, async () => {
    const goal = await projectContext.goalState.read(observedGoal.id);
    const budget = goal.budget;
    if (budget?.maxTokens === undefined) return;

    const nextBudget: GoalBudgetSummary = {
      ...budget,
      status: budget.usedTokens !== undefined && budget.usedTokens + latestUsage.totalTokens >= budget.maxTokens ? "blocked" : budget.status,
      usedTokens: (budget.usedTokens ?? 0) + latestUsage.totalTokens,
      updatedAt: new Date().toISOString(),
    };
    await projectContext.goalState.updateBudgetSummary(goal.id, nextBudget);
    if (isHardExceeded(nextBudget)) {
      const latest = await projectContext.goalState.read(goal.id);
      await blockForHardStop(projectContext, latest, nextBudget, "Budget hard limit exceeded");
    }
  });
}

async function resolveGoalBudgetContext(ctx: GoalBudgetEnforcementContext): Promise<{
  goal: GoalState;
  projectContext: GoalBudgetProjectContext;
} | undefined> {
  const projectContext = ctx.projectContext;
  if (projectContext === undefined) return undefined;
  const goalId = ctx.store.getState().goalId;
  if (goalId === undefined) return undefined;
  const goal = await projectContext.goalState.read(goalId);
  if (goal.budget === undefined) return undefined;
  return { goal, projectContext };
}

function estimateNextModelCallTokens(modelOptions: ModelCallOptions | undefined): number {
  const maxOutputTokens = modelOptions?.maxOutputTokens;
  return typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
    ? Math.ceil(maxOutputTokens)
    : 0;
}

function isHardExceeded(budget: GoalBudgetSummary): boolean {
  return budget.maxTokens !== undefined && (budget.usedTokens ?? 0) >= budget.maxTokens;
}

function shouldRequestWarningApproval(budget: GoalBudgetSummary, estimatedNextCallTokens: number): boolean {
  if (budget.status !== "warning") return false;
  if (budget.reason === GOAL_BUDGET_APPROVAL_PENDING_REASON) return false;
  return (budget.usedTokens ?? 0) + estimatedNextCallTokens >= (budget.usedTokens ?? 0);
}

async function requestBudgetApproval(
  projectContext: GoalBudgetProjectContext,
  goal: GoalState,
  budget: GoalBudgetSummary,
  estimatedNextCallTokens: number,
): Promise<never> {
  const { record } = await projectContext.hitl.create({
    owner: { type: "goal", id: goal.id },
    requestKey: `goal:${goal.id}:budget:${BUDGET_APPROVAL_POINT}`,
    source: {
      type: "goal_budget",
      approvalPoint: BUDGET_APPROVAL_POINT,
    },
    displayPayload: {
      title: "Approve Goal budget warning",
      summary: `Goal ${goal.id} is projected to cross its token budget warning before the next model call.`,
      fields: [
        { label: "Goal ID", value: goal.id },
        { label: "Used tokens", value: String(budget.usedTokens ?? 0) },
        { label: "Estimated next call tokens", value: String(estimatedNextCallTokens) },
        { label: "Maximum tokens", value: String(budget.maxTokens ?? "unset") },
      ],
      redacted: true,
    },
  });
  await projectContext.goalState.attachBudgetApproval(goal.id, {
    hitlId: record.hitlId,
    approvalPoint: BUDGET_APPROVAL_POINT,
  });
  throw new GoalBudgetEnforcementStopError(goal.id, "Goal blocked: budget warning approval is pending");
}

async function blockForHardStop(
  projectContext: GoalBudgetProjectContext,
  goal: GoalState,
  budget: GoalBudgetSummary,
  reason: string,
): Promise<never> {
  await projectContext.goalState.updateBudgetSummary(goal.id, {
    ...budget,
    status: "blocked",
    reason,
    updatedAt: new Date().toISOString(),
  });
  throw new GoalBudgetEnforcementStopError(goal.id, `Goal blocked: ${reason.toLowerCase()}`);
}
