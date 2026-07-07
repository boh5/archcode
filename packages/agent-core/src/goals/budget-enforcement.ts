import { normalizeUsage } from "@archcode/protocol";

import type { ModelCallOptions } from "../config/provider";
import type { ProjectContext } from "../projects/types";
import type { SessionStoreState } from "../store/types";
import type { GoalState, GoalTokenBudgetState } from "./state";
import { updateGoalTokenBudget } from "./budget";
import { writeGoalBudgetArtifact } from "./artifact-lifecycle";

export const BUDGET_APPROVAL_POINT = "approval_budget_1";

export class GoalBudgetEnforcementStopError extends DOMException {
  constructor(public readonly goalId: string, message: string) {
    super(message, "AbortError");
  }
}

export interface GoalBudgetEnforcementContext {
  readonly store: { getState(): SessionStoreState };
  readonly projectContext?: ProjectContext;
  readonly modelOptions?: ModelCallOptions;
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

  const { goal, projectContext } = resolved;
  const budget = goal.tokenBudget;
  if (budget === undefined) return;

  if (isHardExceeded(budget)) {
    await pauseForHardStop(projectContext, goal, budget, "before_model_call");
  }

  const estimatedNextCallTokens = estimateNextModelCallTokens(ctx.modelOptions);
  if (shouldRequestWarningApproval(budget, estimatedNextCallTokens)) {
    await requestBudgetApproval(projectContext, goal, budget, estimatedNextCallTokens);
  }
}

export async function enforceGoalBudgetAfterStepEnd(ctx: GoalBudgetEnforcementContext): Promise<void> {
  const resolved = await resolveGoalBudgetContext(ctx);
  if (resolved === undefined) return;

  const { goal, projectContext } = resolved;
  if (goal.tokenBudget?.maxTokens === undefined && goal.tokenBudget?.warningThresholdTokens === undefined) return;

  const calculation = await updateGoalTokenBudget(projectContext.goalState, projectContext.project.workspaceRoot, goal.id);
  const budget = await mergeLatestLiveStepUsage(projectContext, goal, calculation.budget, ctx.store.getState());
  if (isHardExceeded(budget)) {
    const latest = await projectContext.goalState.read(goal.id);
    await pauseForHardStop(projectContext, latest, budget, "after_step_usage_update");
  }
}

async function resolveGoalBudgetContext(ctx: GoalBudgetEnforcementContext): Promise<{
  goal: GoalState;
  sessionId: string;
  projectContext: ProjectContext;
} | undefined> {
  const projectContext = ctx.projectContext;
  if (projectContext === undefined) return undefined;

  const state = ctx.store.getState();
  if (state.goalId === undefined) return undefined;

  const goal = await projectContext.goalState.read(state.goalId);
  if (goal.tokenBudget === undefined) return undefined;
  return { goal, sessionId: state.sessionId, projectContext };
}

function estimateNextModelCallTokens(modelOptions: ModelCallOptions | undefined): number {
  const maxOutputTokens = modelOptions?.maxOutputTokens;
  return typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
    ? Math.ceil(maxOutputTokens)
    : 0;
}

function isHardExceeded(budget: GoalTokenBudgetState): boolean {
  return budget.maxTokens !== undefined && budget.totalTokens >= budget.maxTokens;
}

function shouldRequestWarningApproval(budget: GoalTokenBudgetState, estimatedNextCallTokens: number): boolean {
  if (budget.warningThresholdTokens === undefined) return false;
  if (budget.warningApprovalPoint === BUDGET_APPROVAL_POINT && budget.warningApprovalThresholdTokens === budget.warningThresholdTokens) {
    return false;
  }
  return budget.totalTokens + estimatedNextCallTokens >= budget.warningThresholdTokens;
}

async function requestBudgetApproval(
  projectContext: ProjectContext,
  goal: GoalState,
  budget: GoalTokenBudgetState,
  estimatedNextCallTokens: number,
): Promise<void> {
  const record = await projectContext.hitl.create({
    owner: { projectSlug: projectContext.project.slug, ownerType: "goal", ownerId: goal.id },
    blockingKey: `goal:${goal.id}:budget:${BUDGET_APPROVAL_POINT}`,
    source: { type: "goal_budget", goalId: goal.id, approvalPoint: BUDGET_APPROVAL_POINT },
    displayPayload: {
      title: "Approve Goal budget warning",
      summary: `Goal "${goal.title}" is projected to cross its token warning threshold before the next model call.`,
      fields: [
        { label: "Goal", value: goal.title },
        { label: "Total tokens", value: String(budget.totalTokens) },
        { label: "Estimated next call tokens", value: String(estimatedNextCallTokens) },
        { label: "Warning threshold", value: String(budget.warningThresholdTokens ?? "unset") },
        { label: "Maximum tokens", value: String(budget.maxTokens ?? "unset") },
      ],
      redacted: true,
    },
  });

  await writeBudgetLedger(projectContext, goal, budget, {
    event: "warning_pending",
    source: "before_model_call",
    reason: "Budget warning approval is pending",
    estimatedNextCallTokens,
  });
  await projectContext.goalState.blockOnHitl(goal.id, {
    version: 1,
    hitlId: record.hitlId,
    blockedAt: new Date().toISOString(),
    phase: goal.phase,
    kind: "goal_budget",
    action: "awaitBudgetApproval",
    approvalPoint: BUDGET_APPROVAL_POINT,
    estimatedNextCallTokens,
    reason: "Budget warning approval is pending",
  });
  await pauseGoal(projectContext, goal, budget, "Budget warning approval is pending");
  throw new GoalBudgetEnforcementStopError(goal.id, "Goal paused: budget warning approval is pending");
}

async function pauseForHardStop(
  projectContext: ProjectContext,
  goal: GoalState,
  budget: GoalTokenBudgetState,
  source: string,
): Promise<never> {
  await pauseGoal(projectContext, goal, { ...budget, status: "paused" }, "Budget hard limit exceeded");
  try {
    await writeBudgetLedger(projectContext, goal, budget, {
      event: "hard_stop",
      source,
      reason: "Goal paused because the hard limit was reached or exceeded.",
    });
  } catch {
    await projectContext.goalState.updateLastError(goal.id, "Budget hard limit exceeded; budget ledger write failed");
  }
  throw new GoalBudgetEnforcementStopError(goal.id, "Goal paused: budget hard limit exceeded");
}

async function pauseGoal(
  projectContext: ProjectContext,
  goal: GoalState,
  budget: GoalTokenBudgetState,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await projectContext.goalState.updateTokenBudget(goal.id, { ...budget, status: "paused", updatedAt: now });
  await projectContext.goalState.updateLastError(goal.id, reason);
  const current = await projectContext.goalState.read(goal.id);
  if (current.status !== "paused" && canPause(current.status)) {
    await projectContext.goalState.transitionStatus(goal.id, "paused");
  }
}

function canPause(status: GoalState["status"]): boolean {
  return status === "locked" || status === "running" || status === "verifying" || status === "reviewed";
}

function budgetStatus(budget: GoalTokenBudgetState): GoalTokenBudgetState["status"] {
  if (budget.maxTokens !== undefined && budget.totalTokens >= budget.maxTokens) return "exceeded";
  if (budget.warningThresholdTokens !== undefined && budget.totalTokens >= budget.warningThresholdTokens) return "warning";
  return "ok";
}

async function mergeLatestLiveStepUsage(
  projectContext: ProjectContext,
  goal: GoalState,
  persistedBudget: GoalTokenBudgetState,
  state: SessionStoreState,
): Promise<GoalTokenBudgetState> {
  const previousBudget = goal.tokenBudget ?? persistedBudget;
  if (persistedBudget.totalTokens > previousBudget.totalTokens) return persistedBudget;

  const latestUsage = normalizeUsage(state.steps.at(-1)?.usage);
  if (latestUsage.totalTokens === 0) return persistedBudget;

  const now = new Date().toISOString();
  const merged: GoalTokenBudgetState = {
    ...previousBudget,
    status: budgetStatus({ ...previousBudget, totalTokens: previousBudget.totalTokens + latestUsage.totalTokens }),
    inputTokens: previousBudget.inputTokens + latestUsage.inputTokens,
    outputTokens: previousBudget.outputTokens + latestUsage.outputTokens,
    reasoningTokens: (previousBudget.reasoningTokens ?? 0) + latestUsage.reasoningTokens,
    cachedInputTokens: (previousBudget.cachedInputTokens ?? 0) + latestUsage.cachedInputTokens,
    totalTokens: previousBudget.totalTokens + latestUsage.totalTokens,
    updatedAt: now,
  };
  await projectContext.goalState.updateTokenBudget(goal.id, merged);
  return merged;
}

async function writeBudgetLedger(
  projectContext: ProjectContext,
  goal: GoalState,
  budget: GoalTokenBudgetState,
  event: {
    event: "warning_pending" | "warning_denied" | "warning_approved" | "hard_stop";
    source: string;
    reason: string;
    estimatedNextCallTokens?: number;
  },
): Promise<void> {
  await writeGoalBudgetArtifact(projectContext.goalArtifacts, goal, budget, event);
}
