import {
  TOOL_CREATE_GOAL,
  TOOL_GET_GOAL,
  TOOL_UPDATE_GOAL,
} from "@archcode/protocol";
import { z } from "zod/v4";

import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type {
  AnyToolDescriptor,
  SessionGoalFreshUserAction,
  ToolExecutionContext,
} from "../types";

export const CreateGoalInputSchema = z.strictObject({});

export const GetGoalInputSchema = z.strictObject({});

const EditGoalInputSchema = z.strictObject({
  action: z.literal("edit"),
  expected_generation: z.number().int().positive().safe()
    .describe("Current Goal generation from get_goal or the Active Goal prompt overlay."),
  mode: z.enum(["amend", "replace"]).describe("amend appends the fresh user amendment to the current Goal; replace makes fresh user input the complete new Goal."),
});

const PauseGoalInputSchema = z.strictObject({ action: z.literal("pause") });
const ResumeGoalInputSchema = z.strictObject({ action: z.literal("resume") });
const ClearGoalInputSchema = z.strictObject({ action: z.literal("clear") });
const SetGoalBudgetInputSchema = z.strictObject({
  action: z.literal("set_budget"),
});
const GoalStatusClaimInputSchema = z.strictObject({
  status: z.enum(["complete", "blocked"]),
  reason: z.string().trim().min(1).describe(
    "Evidence-backed completion reason, or the exact blocker that has persisted for three consecutive Goal turns.",
  ),
});

export const UpdateGoalInputSchema = z.union([
  EditGoalInputSchema,
  PauseGoalInputSchema,
  ResumeGoalInputSchema,
  ClearGoalInputSchema,
  SetGoalBudgetInputSchema,
  GoalStatusClaimInputSchema,
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
        "create",
        validateCreateTokenBudget,
      );
      const tokenBudget = resolveCreateTokenBudget(freshUserInput.text);
      const goal = await service.create({
        workspaceRoot: ctx.projectContext.project.workspaceRoot,
        sessionId: state.sessionId,
        objective: canonicalFreshObjective(freshUserInput.text, "create"),
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
  description: "Read the current Session Goal, including status, objective, usage, budget, evaluator, and review state. This is read-only. Use it when the current Goal snapshot is needed; absence means this Session has no Goal.",
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
  description: "Update the current Session Goal. Edit, pause, resume, clear, or change its budget only when fresh user input explicitly requests that control action; Runtime consumes the capability and the model cannot invent provenance. For edit, use amend to append the fresh user amendment to the existing single objective, or replace to make the fresh user input the complete new objective. status=complete requests independent review and cannot complete the Goal. status=blocked is allowed only after the same real blocker has prevented meaningful progress for three consecutive Goal turns.",
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

      if ("status" in input) {
        if (input.status === "complete") {
          return createTextToolResult(
            "Goal completion claim accepted for independent Runtime review.",
            { sidecar: { executionControl: { action: "request_goal_review", reason: input.reason } } },
          );
        }
        const goal = await service.recordBlockedTurn({
          ...target,
          reason: input.reason,
          executionId: requireCurrentExecutionId(state),
          authority: { kind: "agent" },
        });
        return createTextToolResult(JSON.stringify(goal, null, 2));
      }

      const freshUserInput = await consumeFreshUserInput(
        ctx,
        state,
        input.action,
        input.action === "set_budget"
          ? validateBudgetControl
          : undefined,
      );
      const authority = { kind: "user_control" } as const;
      switch (input.action) {
        case "edit": {
          const current = await service.get(target);
          if (current === undefined) throw new Error("No Session Goal exists to edit");
          return createTextToolResult(JSON.stringify(await service.edit({
            ...target,
            expectedGeneration: input.expected_generation,
            objective: input.mode === "replace"
              ? canonicalFreshObjective(freshUserInput.text, "replace")
              : amendObjective(current.objective, freshUserInput.text),
            authority,
          }), null, 2));
        }
        case "pause":
          return createTextToolResult(JSON.stringify(await service.pause({ ...target, authority }), null, 2));
        case "resume":
          return createTextToolResult(JSON.stringify(await service.resume({ ...target, authority }), null, 2));
        case "clear":
          await service.clear({ ...target, authority });
          return createTextToolResult("Session Goal cleared.");
        case "set_budget": {
          const tokenBudget = resolveBudgetControl(freshUserInput.text);
          return createTextToolResult(JSON.stringify(await service.setTokenBudget({
            ...target,
            ...(tokenBudget === undefined ? {} : { tokenBudget }),
            authority,
          }), null, 2));
        }
      }
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

async function consumeFreshUserInput(
  ctx: ToolExecutionContext,
  state: ReturnType<ToolExecutionContext["store"]["getState"]>,
  action: SessionGoalFreshUserAction,
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
    action,
    ...(validate === undefined ? {} : { validate: ({ text }) => validate(text) }),
  });
}


function requireCurrentExecutionId(
  state: ReturnType<ToolExecutionContext["store"]["getState"]>,
): string {
  if (state.currentExecutionId === undefined) {
    throw new Error("update_goal status claims require a current Execution");
  }
  return state.currentExecutionId;
}

const AMENDMENT_SEPARATOR = "\n\n--- Latest user amendment (overrides direct conflicts; all other requirements remain in force) ---\n\n";

function canonicalFreshObjective(text: string, action: "create" | "replace"): string {
  const objective = text.trim();
  if (objective.length === 0 || objective.length > 4_000) {
    throw new Error(`Cannot ${action === "create" ? "create" : "replace"} the Session Goal: fresh user input must be 1 to 4000 characters and is never truncated.`);
  }
  return objective;
}

function amendObjective(current: string, amendment: string): string {
  const next = `${current}${AMENDMENT_SEPARATOR}${amendment.trim()}`;
  if (next.length > 4_000) {
    throw new Error("Cannot amend the Session Goal because the complete single objective would exceed 4000 characters. Use replace with a concise complete Goal or put detail in a file.");
  }
  return next;
}

function validateCreateTokenBudget(freshUserText: string): void {
  resolveCreateTokenBudget(freshUserText);
}

function validateBudgetControl(freshUserText: string): void {
  resolveBudgetControl(freshUserText);
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

function resolveBudgetControl(freshUserText: string): number | undefined {
  const text = freshUserText.normalize("NFKC").toLowerCase();
  const mentionsTokens = /\b(?:token|tokens)\b|令牌/.test(text);
  const mentionsBudget = /\b(?:budget|cap|limit)\b|预算|上限|限制/.test(text);
  if (!mentionsTokens || !mentionsBudget) {
    throw new Error("Changing the token budget requires an explicit token budget request in the fresh user input");
  }
  return resolveCreateTokenBudget(freshUserText);
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
