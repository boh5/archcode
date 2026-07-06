import { z } from "zod/v4";
import { TOOL_GOAL_MANAGE } from "@archcode/protocol";

import { defineTool } from "../define-tool";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  ApprovalPointSchema,
  DoneConditionSchema,
  GoalPhaseSchema,
  GoalUuidSchema,
  RetryPolicySchema,
} from "../../goals/state";
import {
  assertGoalManageActionAuthorized,
  createGoalRunnerFromContext,
  formatGoalToolResult,
  goalToolErrorResult,
} from "./goal-tools/helpers";

const GoalManageCreateInputSchema = z.strictObject({
  action: z.literal("create"),
  title: z.string().trim().min(1).max(200).describe("Human-readable Goal title."),
  doneConditions: z.array(DoneConditionSchema).describe("Done Conditions that define Goal completion."),
  retryPolicy: RetryPolicySchema.describe("Retry limits and escalation policy for this Goal."),
  approvalPoints: z.array(ApprovalPointSchema).describe("Human approval checkpoints required by this Goal."),
  author: z.string().trim().min(1).describe("Author or source of the Goal contract."),
});

const GoalManageLockInputSchema = z.strictObject({
  action: z.literal("lock"),
  goalId: GoalUuidSchema.describe("Goal UUID to lock."),
});

const GoalManageStartInputSchema = z.strictObject({
  action: z.literal("start"),
  goalId: GoalUuidSchema.describe("Goal UUID to start running."),
});

const GoalManageAdvancePhaseInputSchema = z.strictObject({
  action: z.literal("advance_phase"),
  goalId: GoalUuidSchema.describe("Goal UUID whose lifecycle phase should advance."),
  nextPhase: GoalPhaseSchema.extract(["build", "review"]).describe("Next lifecycle phase."),
});

const GoalManageRetryInputSchema = z.strictObject({
  action: z.literal("retry"),
  goalId: GoalUuidSchema.describe("Goal UUID to retry from a fresh plan phase."),
});

const GoalManageFinalizeReviewInputSchema = z.strictObject({
  action: z.literal("finalize_review"),
  goalId: GoalUuidSchema.describe("Goal UUID whose Reviewer review should be finalized."),
  outcome: z.enum(["DONE", "NOT_DONE"]).describe("External Reviewer outcome."),
  summary: z.string().trim().min(1).max(20_000).optional().describe("Bounded Reviewer summary."),
});

const GoalManageInputSchema = z.discriminatedUnion("action", [
  GoalManageCreateInputSchema,
  GoalManageLockInputSchema,
  GoalManageStartInputSchema,
  GoalManageAdvancePhaseInputSchema,
  GoalManageRetryInputSchema,
  GoalManageFinalizeReviewInputSchema,
]);

type GoalManageInput = z.infer<typeof GoalManageInputSchema>;

export const goalManageTool: AnyToolDescriptor = defineTool({
  name: TOOL_GOAL_MANAGE,
  description: "Manage the authorized Goal lifecycle action: create, lock, start, advance_phase, retry, or finalize_review.",
  inputSchema: GoalManageInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: async (input: GoalManageInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
    try {
      const runner = createGoalRunnerFromContext(ctx);

      switch (input.action) {
        case "create": {
          assertGoalManageActionAuthorized(input.action, ctx);
          const goal = await runner.createDraft({
            projectId: ctx.projectContext.project.slug,
            title: input.title,
            author: input.author,
            doneConditions: input.doneConditions,
            retryPolicy: input.retryPolicy,
            approvalPoints: input.approvalPoints,
          });
          return formatGoalToolResult(goal);
        }
        case "lock": {
          const authorization = assertGoalManageActionAuthorized(input.action, ctx);
          const goal = await runner.lockDraft(input.goalId, authorization.sessionId);
          return formatGoalToolResult(goal);
        }
        case "start": {
          const authorization = assertGoalManageActionAuthorized(input.action, ctx);
          const goal = await runner.claimStart(input.goalId, authorization.sessionId);
          return formatGoalToolResult(goal);
        }
        case "advance_phase": {
          assertGoalManageActionAuthorized(input.action, ctx);
          const goal = await runner.advancePhase(input.goalId, input.nextPhase);
          return formatGoalToolResult(goal);
        }
        case "retry": {
          assertGoalManageActionAuthorized(input.action, ctx);
          const goal = await runner.handleFailedVerification(input.goalId, "Retry requested by goal_manage.retry", {
            abort: ctx.abort,
          });
          return formatGoalToolResult(goal);
        }
        case "finalize_review": {
          const goalForAuthorization = await ctx.projectContext.goalState.read(input.goalId);
          const authorization = assertGoalManageActionAuthorized(input.action, ctx, goalForAuthorization);
          const goal = await runner.finalizeReviewerReview(input.goalId, input.outcome, {
            reviewerAgent: authorization.agentName,
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            abort: ctx.abort,
          });
          return formatGoalToolResult(goal);
        }
      }
    } catch (error) {
      return goalToolErrorResult(error, {
        runnerErrorCode: input.action === "finalize_review" ? "GOAL_REVIEW_PHASE_REQUIRED" : "GOAL_INVALID_TRANSITION",
      });
    }
  },
});

export { GoalManageInputSchema };
