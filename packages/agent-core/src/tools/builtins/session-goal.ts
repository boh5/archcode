import {
  SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH,
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  TOOL_CREATE_GOAL,
  TOOL_GET_GOAL,
  TOOL_UPDATE_GOAL,
} from "@archcode/protocol";
import { z } from "zod/v4";

import { finalOutputForExecution, latestExecution } from "../../delegation/final-output";
import { hasKnownArtifactWriteAfter } from "../../session-goal/review-provenance";
import type { GoalReviewBinding, SessionStoreState } from "../../store/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type {
  AnyToolDescriptor,
  ToolExecutionContext,
} from "../types";

export const CreateGoalInputSchema = z.strictObject({
  objective: z.string().trim().min(1).max(SESSION_GOAL_OBJECTIVE_MAX_LENGTH)
    .describe("The complete persistent objective the user requested or confirmed."),
});

export const GetGoalInputSchema = z.strictObject({});

const CompleteGoalInputSchema = z.strictObject({
  status: z.literal("complete")
    .describe("Mark complete only after a fresh independent Goal review proves the objective achieved."),
  reason: z.string().trim().min(1).describe("Evidence-backed completion reason after a fresh independent Goal review approved the work."),
  review_session_id: z.string().trim().min(1).describe("Fresh direct deep Analyst child with goal-review whose one terminal review output returned VERDICT: APPROVED."),
});
const BlockGoalInputSchema = z.strictObject({
  status: z.literal("blocked")
    .describe("Mark blocked only when a genuine blocker prevents meaningful progress."),
  reason: z.string().trim().min(1).max(SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH)
    .describe("The genuine blocker preventing meaningful progress."),
});

export const UpdateGoalInputSchema = z.discriminatedUnion("status", [
  CompleteGoalInputSchema,
  BlockGoalInputSchema,
]);

type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;
type UpdateGoalInput = z.infer<typeof UpdateGoalInputSchema>;

export const createGoalTool: AnyToolDescriptor = defineTool({
  name: TOOL_CREATE_GOAL,
  description: "Create a persistent Goal on the current root Lead Session. Before calling this tool, ask the user with the ordinary ask_user tool and interpret the answer normally. Call only when the Lead determines that the user agreed. Discussion Sessions cannot create Goals.",
  inputSchema: CreateGoalInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input: CreateGoalInput, ctx: ToolExecutionContext) => {
    try {
      const state = await assertRootLead(ctx, TOOL_CREATE_GOAL);
      const service = requireSessionGoalService(ctx);
      const objective = canonicalGoalObjective(input.objective);
      const tokenBudget = resolveCreateTokenBudget(objective);
      const goal = await service.create({
        workspaceRoot: ctx.projectContext.project.workspaceRoot,
        sessionId: state.sessionId,
        objective,
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
        authority: { kind: "user_control" },
      });
      return createTextToolResult(JSON.stringify({
        status: "created",
        instanceId: goal.instanceId,
        generation: goal.generation,
      }));
    } catch (error) {
      return sessionGoalToolError(error);
    }
  },
});

export const getGoalTool: AnyToolDescriptor = defineTool({
  name: TOOL_GET_GOAL,
  description: "Read accounting only for the current Session Goal: normalized token usage, accumulated execution time, execution count, and optional token budget. This is read-only and never returns the objective, status, or blocked reason; use the latest GoalNotice for semantic Goal state. Absence means this Session has no Goal.",
  inputSchema: GetGoalInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (_input: Record<string, never>, ctx: ToolExecutionContext) => {
    try {
      const state = await assertRootLead(ctx, TOOL_GET_GOAL);
      const goal = await requireSessionGoalService(ctx).get({
        workspaceRoot: ctx.projectContext.project.workspaceRoot,
        sessionId: state.sessionId,
      });
      return createTextToolResult(JSON.stringify(goal === undefined ? null : {
        ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
        usage: goal.usage,
      }, null, 2));
    } catch (error) {
      return sessionGoalToolError(error);
    }
  },
});

export const updateGoalTool: AnyToolDescriptor = defineTool({
  name: TOOL_UPDATE_GOAL,
  description: "Set the current Session Goal status to complete or blocked. Completion requires a fresh direct deep Analyst child with goal-review, runtime Goal provenance, exactly one completed review outcome whose first non-empty line is VERDICT: APPROVED, no later ArchCode-known artifact write, and no active child. status=blocked records only a genuine blocker.",
  inputSchema: UpdateGoalInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input: UpdateGoalInput, ctx: ToolExecutionContext) => {
    try {
      const state = await assertRootLead(ctx, TOOL_UPDATE_GOAL);
      const target = {
        workspaceRoot: ctx.projectContext.project.workspaceRoot,
        sessionId: state.sessionId,
      };
      const service = requireSessionGoalService(ctx);

      if (input.status === "complete") {
        const approvedGoal = await assertApprovedGoalReview(ctx, state, input.review_session_id);
        const goal = await service.complete({
          ...target,
          reason: input.reason,
          authority: { kind: "agent" },
          expectedInstanceId: approvedGoal.instanceId,
          expectedGeneration: approvedGoal.generation,
        });
        return createTextToolResult(JSON.stringify(goal, null, 2), {
          sidecar: { executionCompleted: true },
        });
      }
      const goal = await service.block({ ...target, reason: input.reason, authority: { kind: "agent" } });
      return createTextToolResult(JSON.stringify(goal, null, 2));
    } catch (error) {
      return sessionGoalToolError(error);
    }
  },
});

async function assertRootLead(ctx: ToolExecutionContext, toolName: string) {
  const state = ctx.store.getState();
  const agentName = ctx.agentName ?? state.agentName;
  if (
    agentName !== "lead"
    || state.agentName !== "lead"
    || state.sessionId !== state.rootSessionId
    || state.parentSessionId !== undefined
  ) {
    throw new Error(`${toolName} requires the current root Lead Session`);
  }
  const discussion = await ctx.projectContext.todos.state.findByDiscussionSessionId(state.sessionId);
  if (discussion !== undefined) throw new Error(`${toolName} is unavailable in a Project Todo Discussion`);
  return state;
}

function requireSessionGoalService(ctx: ToolExecutionContext) {
  if (ctx.sessionGoalService === undefined) {
    throw new Error("Session Goal service is unavailable in this Runtime");
  }
  return ctx.sessionGoalService;
}

async function assertApprovedGoalReview(
  ctx: ToolExecutionContext,
  rootState: SessionStoreState,
  reviewSessionId: string,
): Promise<Pick<NonNullable<SessionStoreState["goal"]>, "instanceId" | "generation">> {
  const goal = rootState.goal;
  if (goal === undefined || goal.status !== "active") throw new Error("Goal completion requires the current active Goal");
  const directReviewLink = rootState.childSessionLinks.find((link) =>
    link.parentSessionId === rootState.sessionId
    && link.childSessionId === reviewSessionId
    && link.childAgentName === "analyst"
    && link.childProfile === "deep"
    && link.childSkillNames.includes("goal-review")
  );
  if (directReviewLink === undefined) {
    throw new Error("Goal completion requires a direct deep Analyst child with goal-review");
  }

  const reviewStore = await ctx.storeManager.getOrLoad(
    reviewSessionId,
    ctx.projectContext.project.workspaceRoot,
  );
  const reviewState = reviewStore.getState();
  if (
    reviewState.agentName !== "analyst"
    || reviewState.parentSessionId !== rootState.sessionId
    || reviewState.rootSessionId !== rootState.sessionId
    || reviewState.delegationRequest?.profile !== "deep"
    || !reviewState.delegationRequest.skills.includes("goal-review")
  ) {
    throw new Error("Goal completion requires a direct deep Analyst child with goal-review");
  }

  const binding: GoalReviewBinding | undefined = reviewState.goalReviewBinding;
  if (
    binding?.goalInstanceId !== goal.instanceId
    || binding.goalGeneration !== goal.generation
    || binding.rootSessionId !== rootState.sessionId
    || binding.createdAt < goal.updatedAt
    || directReviewLink.createdAt !== binding.createdAt
  ) throw new Error("Goal review provenance does not bind this fresh Analyst to the current Goal generation");

  const execution = latestExecution(reviewState);
  if (execution?.status !== "completed") {
    throw new Error("Goal completion requires the review Analyst's latest Execution to be completed");
  }
  const completedExecutions = reviewState.executions.filter((candidate) => candidate.status === "completed");
  if (completedExecutions.length !== 1 || completedExecutions[0]?.id !== execution.id) {
    throw new Error("A completed Goal review attempt is terminal and cannot be rewritten by resuming it");
  }
  const output = finalOutputForExecution(reviewState, execution.id);
  const verdict = output
    ?.split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (verdict !== "VERDICT: APPROVED") {
    throw new Error("Goal completion requires the review Analyst's final output to begin with VERDICT: APPROVED");
  }
  await assertReviewFreshness(ctx, rootState, reviewSessionId, binding.createdAt);
  return { instanceId: goal.instanceId, generation: goal.generation };
}

const ACTIVE_CHILD_STATUSES = new Set(["linked", "running", "waiting_for_human", "cancelling"]);

async function assertReviewFreshness(
  ctx: ToolExecutionContext,
  rootState: SessionStoreState,
  reviewSessionId: string,
  reviewCreatedAt: number,
): Promise<void> {
  const states = await loadFamilyStates(ctx, rootState);
  for (const state of states) {
    if (state.childSessionLinks.some((link) => link.childSessionId !== reviewSessionId && ACTIVE_CHILD_STATUSES.has(link.status))) {
      throw new Error("Goal completion requires every other child in the Session family to be terminal");
    }
    if (hasKnownArtifactWriteAfter(state, reviewCreatedAt, ctx.projectContext.project.workspaceRoot)) {
      throw new Error("Goal review is stale because ArchCode completed an artifact write after the review started");
    }
  }
}

async function loadFamilyStates(ctx: ToolExecutionContext, rootState: SessionStoreState): Promise<SessionStoreState[]> {
  const states: SessionStoreState[] = [];
  const pending = [rootState];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const state = pending.shift()!;
    if (seen.has(state.sessionId)) continue;
    seen.add(state.sessionId);
    states.push(state);
    for (const childId of state.childSessionLinks.map((link) => link.childSessionId)) {
      if (seen.has(childId)) continue;
      pending.push((await ctx.storeManager.getOrLoad(childId, ctx.projectContext.project.workspaceRoot)).getState());
    }
  }
  return states;
}

function canonicalGoalObjective(text: string): string {
  const objective = text.trim();
  if (objective.length === 0 || objective.length > SESSION_GOAL_OBJECTIVE_MAX_LENGTH) {
    throw new Error(`Cannot create the Session Goal: objective must be 1 to ${SESSION_GOAL_OBJECTIVE_MAX_LENGTH} characters.`);
  }
  return objective;
}

function resolveCreateTokenBudget(objective: string): number | undefined {
  const text = objective.normalize("NFKC").toLowerCase();
  const mentionsTokens = /\b(?:token|tokens)\b|令牌/.test(text);
  const mentionsBudget = /\b(?:budget|cap|limit)\b|预算|上限|限制/.test(text);
  if (!mentionsTokens || !mentionsBudget) return undefined;
  const explicitBudgets = extractExplicitTokenBudgets(text);
  if (explicitBudgets.size === 0) {
    if (hasBudgetRemovalIntent(text)) return undefined;
    throw new Error("An explicit token budget request must state exactly one positive numeric budget");
  }
  if (explicitBudgets.size > 1 || hasBudgetRemovalIntent(text)) {
    throw new Error("The Goal objective contains an ambiguous token budget; state exactly one budget or remove it");
  }
  return explicitBudgets.values().next().value;
}

function hasBudgetRemovalIntent(text: string): boolean {
  return /\b(?:remove|clear|unset|unlimited|no\s+limit|without\s+(?:a\s+)?(?:token\s+)?(?:budget|cap|limit))\b|取消|移除|清除|不限|不设/.test(text);
}

function extractExplicitTokenBudgets(text: string): ReadonlySet<number> {
  const budgets = new Set<number>();
  const numberPattern = /(\d[\d,_]*(?:\.\d+)?)\s*(k|m|万)?/g;
  for (const match of text.matchAll(numberPattern)) {
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 48), index);
    const after = text.slice(index + match[0].length, index + match[0].length + 48);
    const budgetImmediatelyBefore = /(?:(?:token|tokens|令牌)\s*)?(?:budget|cap|limit|预算|上限|限制)(?:\s+(?:of|to|at|is))?\s*[:=为到是]?\s*$/i.test(before);
    const tokenBudgetImmediatelyAfter = /^\s*(?:token|tokens|令牌)\s*(?:budget|cap|limit|预算|上限|限制)/i.test(after);
    if (!budgetImmediatelyBefore && !tokenBudgetImmediatelyAfter) {
      continue;
    }
    const raw = match[1]?.replaceAll(",", "").replaceAll("_", "");
    if (raw === undefined) continue;
    const base = Number(raw);
    const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "万" ? 10_000 : 1;
    const value = base * multiplier;
    if (Number.isSafeInteger(value) && value > 0) budgets.add(value);
  }
  return budgets;
}

function sessionGoalToolError(error: unknown) {
  return createToolErrorResult({
    kind: "execution",
    error: error instanceof Error ? error : new Error(String(error)),
  });
}
