import {
  SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH,
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  TOOL_CREATE_GOAL,
  TOOL_GET_GOAL,
  TOOL_UPDATE_GOAL,
} from "@archcode/protocol";
import { z } from "zod/v4";

import type { SessionStoreState } from "../../store/types";
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
    .describe("Mark complete only after the Lead determines that the current Goal is achieved."),
  reason: z.string().trim().min(1).describe("Evidence-backed reason that the current Goal is complete."),
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
      const goal = await service.create({
        workspaceRoot: ctx.projectContext.project.workspaceRoot,
        sessionId: state.sessionId,
        objective,
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
  description: "Set the current Session Goal status to complete or blocked. Complete only after finishing the work, verifying it, and interpreting a fresh independent Goal review; every child in the Session family must already be terminal. status=blocked records only a genuine blocker.",
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
        const currentGoal = state.goal;
        if (currentGoal === undefined || currentGoal.status !== "active") {
          throw new Error("Goal completion requires the current active Goal");
        }
        await assertNoActiveChildren(ctx, state);
        const goal = await service.complete({
          ...target,
          reason: input.reason,
          authority: { kind: "agent" },
          expectedInstanceId: currentGoal.instanceId,
          expectedGeneration: currentGoal.generation,
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

const ACTIVE_CHILD_STATUSES = new Set(["linked", "running", "waiting_for_human", "cancelling"]);

async function assertNoActiveChildren(
  ctx: ToolExecutionContext,
  rootState: SessionStoreState,
): Promise<void> {
  const states = await loadFamilyStates(ctx, rootState);
  for (const state of states) {
    if (state.childSessionLinks.some((link) => ACTIVE_CHILD_STATUSES.has(link.status))) {
      throw new Error("Goal completion requires every child in the Session family to be terminal");
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

function sessionGoalToolError(error: unknown) {
  return createToolErrorResult({
    kind: "execution",
    error: error instanceof Error ? error : new Error(String(error)),
  });
}
