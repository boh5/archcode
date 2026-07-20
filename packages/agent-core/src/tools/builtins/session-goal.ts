import {
  TOOL_CREATE_GOAL,
  TOOL_GET_GOAL,
  TOOL_UPDATE_GOAL,
} from "@archcode/protocol";
import { z } from "zod/v4";

import { finalOutputForExecution, latestExecution } from "../../delegation/final-output";
import type { SessionStoreState } from "../../store/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type {
  AnyToolDescriptor,
  ToolExecutionContext,
} from "../types";

export const CreateGoalInputSchema = z.strictObject({});

export const GetGoalInputSchema = z.strictObject({});

const CompleteGoalInputSchema = z.strictObject({
  status: z.literal("complete"),
  reason: z.string().trim().min(1).describe("Evidence-backed completion reason after an independent Reviewer approved the work."),
  review_session_id: z.string().trim().min(1).describe("Direct Reviewer child Session whose latest completed Execution returned VERDICT: APPROVED."),
});
const BlockGoalInputSchema = z.strictObject({
  status: z.literal("blocked"),
  reason: z.string().trim().min(1).describe("The genuine blocker preventing meaningful progress."),
});

export const UpdateGoalInputSchema = z.discriminatedUnion("status", [
  CompleteGoalInputSchema,
  BlockGoalInputSchema,
]);

type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;
type UpdateGoalInput = z.infer<typeof UpdateGoalInputSchema>;

export const createGoalTool: AnyToolDescriptor = defineTool({
  name: TOOL_CREATE_GOAL,
  description: "Create a persistent Goal on the current root Engineer Session from fresh user input when the user clearly asks ArchCode to keep working through multiple rounds or delegated work until a verifiable outcome is reached. Do not use for a one-step change, question, status request, diagnosis, or one-time research report. The Runtime uses the fresh user input itself as the entire objective; you cannot rewrite it. Runtime derives a token budget only from one explicit unambiguous budget in that input; no budget means no hard cap. If the objective is not already a clear verifiable endpoint, clarify in ordinary conversation first. Activation is immediate without a Skill or confirmation ceremony.",
  inputSchema: CreateGoalInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input: CreateGoalInput, ctx: ToolExecutionContext) => {
    try {
      const state = assertRootEngineer(ctx, TOOL_CREATE_GOAL);
      const service = requireSessionGoalService(ctx);
      const freshUserInput = await consumeFreshUserInput(
        ctx,
        state,
        validateCreateTokenBudget,
      );
      const tokenBudget = resolveCreateTokenBudget(freshUserInput.text);
      const goal = await service.create({
        workspaceRoot: ctx.projectContext.project.workspaceRoot,
        sessionId: state.sessionId,
        objective: canonicalFreshObjective(freshUserInput.text),
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
        authority: { kind: "user_control" },
      });
      return createTextToolResult(JSON.stringify(goal, null, 2));
    } catch (error) {
      return sessionGoalToolError(error);
    }
  },
});

export const getGoalTool: AnyToolDescriptor = defineTool({
  name: TOOL_GET_GOAL,
  description: "Read the current Session Goal, including its objective, status, usage, and optional budget. This is read-only; absence means this Session has no Goal.",
  inputSchema: GetGoalInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (_input: Record<string, never>, ctx: ToolExecutionContext) => {
    try {
      const state = assertRootEngineer(ctx, TOOL_GET_GOAL);
      const goal = await requireSessionGoalService(ctx).get({
        workspaceRoot: ctx.projectContext.project.workspaceRoot,
        sessionId: state.sessionId,
      });
      return createTextToolResult(JSON.stringify(goal ?? null, null, 2));
    } catch (error) {
      return sessionGoalToolError(error);
    }
  },
});

export const updateGoalTool: AnyToolDescriptor = defineTool({
  name: TOOL_UPDATE_GOAL,
  description: "Set the current Session Goal status to complete or blocked. Before status=complete, delegate an independent Reviewer, read its normal final report, and pass the direct Reviewer Session whose latest completed Execution begins with VERDICT: APPROVED. status=blocked immediately records a genuine blocker. Goal edits, pause, resume, clear, and budget controls are user-owned API/UI actions and are not accepted by this tool.",
  inputSchema: UpdateGoalInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input: UpdateGoalInput, ctx: ToolExecutionContext) => {
    try {
      const state = assertRootEngineer(ctx, TOOL_UPDATE_GOAL);
      const target = {
        workspaceRoot: ctx.projectContext.project.workspaceRoot,
        sessionId: state.sessionId,
      };
      const service = requireSessionGoalService(ctx);

      if (input.status === "complete") {
        await assertApprovedReviewer(ctx, state, input.review_session_id);
        const goal = await service.complete({ ...target, reason: input.reason, authority: { kind: "agent" } });
        return createTextToolResult(JSON.stringify(goal, null, 2));
      }
      const goal = await service.block({ ...target, reason: input.reason, authority: { kind: "agent" } });
      return createTextToolResult(JSON.stringify(goal, null, 2));
    } catch (error) {
      return sessionGoalToolError(error);
    }
  },
});

function assertRootEngineer(ctx: ToolExecutionContext, toolName: string) {
  const state = ctx.store.getState();
  const agentName = ctx.agentName ?? state.agentName;
  if (
    agentName !== "engineer"
    || state.agentName !== "engineer"
    || state.sessionId !== state.rootSessionId
    || state.parentSessionId !== undefined
  ) {
    throw new Error(`${toolName} requires the current root Engineer Session`);
  }
  return state;
}

function requireSessionGoalService(ctx: ToolExecutionContext) {
  if (ctx.sessionGoalService === undefined) {
    throw new Error("Session Goal service is unavailable in this Runtime");
  }
  return ctx.sessionGoalService;
}

async function assertApprovedReviewer(
  ctx: ToolExecutionContext,
  rootState: SessionStoreState,
  reviewSessionId: string,
): Promise<void> {
  const directReviewerLink = rootState.childSessionLinks.find((link) =>
    link.parentSessionId === rootState.sessionId
    && link.childSessionId === reviewSessionId
    && link.childAgentName === "reviewer"
  );
  if (directReviewerLink === undefined) {
    throw new Error("Goal completion requires a direct Reviewer child of the current root Engineer Session");
  }

  const reviewerStore = await ctx.storeManager.getOrLoad(
    reviewSessionId,
    ctx.projectContext.project.workspaceRoot,
  );
  const reviewerState = reviewerStore.getState();
  if (
    reviewerState.agentName !== "reviewer"
    || reviewerState.parentSessionId !== rootState.sessionId
    || reviewerState.rootSessionId !== rootState.sessionId
  ) {
    throw new Error("Goal completion requires a direct Reviewer child of the current root Engineer Session");
  }

  const execution = latestExecution(reviewerState);
  if (execution?.status !== "completed") {
    throw new Error("Goal completion requires the Reviewer's latest Execution to be completed");
  }
  const output = finalOutputForExecution(reviewerState, execution.id);
  const verdict = output
    ?.split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (verdict !== "VERDICT: APPROVED") {
    throw new Error("Goal completion requires the Reviewer's latest final output to begin with VERDICT: APPROVED");
  }
}

async function consumeFreshUserInput(
  ctx: ToolExecutionContext,
  state: ReturnType<ToolExecutionContext["store"]["getState"]>,
  validate?: (text: string) => void,
): Promise<{ readonly text: string }> {
  if (ctx.consumeFreshUserInput === undefined) {
    throw new Error(`${ctx.toolName} requires a fresh direct, queue, or steer user input capability`);
  }
  return await ctx.consumeFreshUserInput({
    workspaceRoot: ctx.projectContext.project.workspaceRoot,
    sessionId: state.sessionId,
    rootSessionId: state.rootSessionId,
    toolCallId: ctx.toolCallId,
    ...(validate === undefined ? {} : { validate: ({ text }) => validate(text) }),
  });
}

function canonicalFreshObjective(text: string): string {
  const objective = text.trim();
  if (objective.length === 0 || objective.length > 4_000) {
    throw new Error("Cannot create the Session Goal: fresh user input must be 1 to 4000 characters and is never truncated.");
  }
  return objective;
}

function validateCreateTokenBudget(freshUserText: string): void {
  resolveCreateTokenBudget(freshUserText);
}

function resolveCreateTokenBudget(freshUserText: string): number | undefined {
  const text = freshUserText.normalize("NFKC").toLowerCase();
  const mentionsTokens = /\b(?:token|tokens)\b|令牌/.test(text);
  const mentionsBudget = /\b(?:budget|cap|limit)\b|预算|上限|限制/.test(text);
  if (!mentionsTokens || !mentionsBudget) return undefined;
  const explicitBudgets = extractExplicitTokenBudgets(text);
  if (explicitBudgets.size === 0) {
    if (hasBudgetRemovalIntent(text)) return undefined;
    throw new Error("An explicit token budget request must state exactly one positive numeric budget");
  }
  if (explicitBudgets.size > 1 || hasBudgetRemovalIntent(text)) {
    throw new Error("The fresh user input contains an ambiguous token budget; state exactly one budget or remove it");
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
