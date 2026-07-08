import { z } from "zod/v4";
import {
  TOOL_GOAL_MANAGE,
  type GoalBlockerKind,
  type GoalEvidenceRef,
  type GoalReviewVerdict,
  type GoalState,
} from "@archcode/protocol";

import { defineTool } from "../define-tool";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import { GoalUuidSchema } from "../../goals/state";
import {
  assertGoalManageActionAuthorized,
  formatGoalToolResult,
  goalToolErrorResult,
} from "./goal-tools/helpers";

const GoalTextSchema = z.string().trim().min(1);
const GoalTitleSchema = GoalTextSchema.max(160);
const GoalLongMarkdownSchema = GoalTextSchema.max(8_000);
const GoalReceiptSummarySchema = GoalTextSchema.max(4_000);
const GoalEvidenceSummarySchema = GoalTextSchema.max(1_000);

const GoalEvidenceRefSchema = z.strictObject({
  kind: z.enum(["session", "message", "tool_call", "diff", "test_output", "file", "url", "hitl"]),
  ref: GoalTextSchema,
  summary: GoalEvidenceSummarySchema,
  sessionId: GoalTextSchema.optional(),
  messageId: GoalTextSchema.optional(),
  toolCallId: GoalTextSchema.optional(),
  path: GoalTextSchema.optional(),
  url: z.url().optional(),
  createdAt: GoalTextSchema.optional(),
}) satisfies z.ZodType<GoalEvidenceRef>;

const GoalManageCreateInputSchema = z.strictObject({
  action: z.literal("create"),
  title: GoalTitleSchema.describe("Human-readable Goal title."),
  objective: GoalLongMarkdownSchema.describe("Natural-language objective for the Goal."),
  acceptanceCriteria: GoalLongMarkdownSchema.describe("Natural-language acceptance criteria for Reviewer judgment."),
});

const GoalManageStartInputSchema = z.strictObject({
  action: z.literal("start"),
  goalId: GoalUuidSchema.describe("Goal UUID to start running."),
});

const GoalManageBlockInputSchema = z.strictObject({
  action: z.literal("block"),
  goalId: GoalUuidSchema.describe("Goal UUID to block."),
  kind: z.enum(["approval", "question", "budget", "permission", "tool_error"]) satisfies z.ZodType<GoalBlockerKind>,
  summary: GoalReceiptSummarySchema.describe("Short blocker summary."),
  hitlId: GoalTextSchema.optional(),
  source: GoalTextSchema.optional(),
  resumeStatus: z.enum(["running", "reviewing"]).optional(),
});

const GoalManageResumeInputSchema = z.strictObject({
  action: z.literal("resume"),
  goalId: GoalUuidSchema.describe("Goal UUID to resume."),
  hitlId: GoalTextSchema.optional().describe("Optional HITL id to clear before resuming."),
});

const GoalManageBeginReviewInputSchema = z.strictObject({
  action: z.literal("begin_review"),
  goalId: GoalUuidSchema.describe("Goal UUID whose execution should move into review."),
  reviewerSessionId: GoalTextSchema.optional().describe("Optional existing Reviewer session id."),
});

const GoalManageFinalizeReviewInputSchema = z.strictObject({
  action: z.literal("finalize_review"),
  goalId: GoalUuidSchema.describe("Goal UUID whose Reviewer receipt should be recorded."),
  verdict: z.enum(["DONE", "NOT_DONE"]) satisfies z.ZodType<GoalReviewVerdict>,
  summary: GoalReceiptSummarySchema.describe("Reviewer result summary."),
  evidenceRefs: z.array(GoalEvidenceRefSchema).max(20).describe("Evidence references supporting the verdict."),
  unresolvedItems: z.array(GoalTextSchema.max(1_000)).max(20).optional(),
  finalSummary: GoalReceiptSummarySchema.optional(),
});

const GoalManageRetryInputSchema = z.strictObject({
  action: z.literal("retry"),
  goalId: GoalUuidSchema.describe("Goal UUID to retry."),
});

const GoalManageCancelInputSchema = z.strictObject({
  action: z.literal("cancel"),
  goalId: GoalUuidSchema.describe("Goal UUID to cancel."),
  reason: GoalReceiptSummarySchema.optional(),
});

const GoalManageInputSchema = z.discriminatedUnion("action", [
  GoalManageCreateInputSchema,
  GoalManageStartInputSchema,
  GoalManageBlockInputSchema,
  GoalManageResumeInputSchema,
  GoalManageBeginReviewInputSchema,
  GoalManageFinalizeReviewInputSchema,
  GoalManageRetryInputSchema,
  GoalManageCancelInputSchema,
]).superRefine((input, ctx) => {
  if (input.action === "finalize_review" && input.verdict === "DONE" && input.evidenceRefs.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["evidenceRefs"],
      message: "goal_manage.finalize_review with DONE requires at least one evidence ref.",
    });
  }
});

type GoalManageInput = z.infer<typeof GoalManageInputSchema>;

interface SimplifiedGoalStateManager {
  create(input: {
    projectId: string;
    title: string;
    objective: string;
    acceptanceCriteria: string;
  }): Promise<GoalState>;
  start(goalId: string, input: { readonly mainSessionId?: string }): Promise<GoalState>;
  block(goalId: string, blocker: {
    kind: GoalBlockerKind;
    summary: string;
    hitlId?: string;
    source?: string;
    resumeStatus?: "running" | "reviewing";
  }): Promise<GoalState>;
  clearBlocker(goalId: string, hitlId?: string): Promise<GoalState>;
  beginReview(goalId: string): Promise<GoalState>;
  finalizeReview(goalId: string, input: {
    readonly verdict: GoalReviewVerdict;
    readonly summary: string;
    readonly evidenceRefs?: readonly GoalEvidenceRef[];
    readonly unresolvedItems?: readonly string[];
    readonly finalSummary?: string;
    readonly authorization: {
      readonly agentName?: string;
      readonly sessionRole?: string;
      readonly sessionGoalId?: string;
      readonly reviewerSessionId?: string;
    };
  }): Promise<GoalState>;
  retry(goalId: string, input: { readonly mainSessionId?: string }): Promise<GoalState>;
  cancel(goalId: string, reason?: string): Promise<GoalState>;
}

export const goalManageTool: AnyToolDescriptor = defineTool({
  name: TOOL_GOAL_MANAGE,
  description: "Manage the simplified Goal lifecycle: create, start, block, resume, begin_review, finalize_review, retry, or cancel.",
  inputSchema: GoalManageInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  execute: async (input: GoalManageInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
    try {
      const authorization = assertGoalManageActionAuthorized(
        input.action,
        ctx,
        "goalId" in input ? input.goalId : undefined,
      );
      const manager = simplifiedGoalStateManager(ctx);

      switch (input.action) {
        case "create": {
          return formatGoalToolResult(await manager.create({
            projectId: ctx.projectContext.project.slug,
            title: input.title,
            objective: input.objective,
            acceptanceCriteria: input.acceptanceCriteria,
          }));
        }
        case "start": {
          return formatGoalToolResult(await manager.start(input.goalId, { mainSessionId: authorization.sessionId }));
        }
        case "block": {
          return formatGoalToolResult(await manager.block(input.goalId, {
            kind: input.kind,
            summary: input.summary,
            ...(input.hitlId === undefined ? {} : { hitlId: input.hitlId }),
            ...(input.source === undefined ? {} : { source: input.source }),
            ...(input.resumeStatus === undefined ? {} : { resumeStatus: input.resumeStatus }),
          }));
        }
        case "resume": {
          return formatGoalToolResult(await manager.clearBlocker(input.goalId, input.hitlId));
        }
        case "begin_review": {
          return formatGoalToolResult(await manager.beginReview(input.goalId));
        }
        case "finalize_review": {
          return formatGoalToolResult(await manager.finalizeReview(input.goalId, {
            verdict: input.verdict,
            summary: input.summary,
            evidenceRefs: input.evidenceRefs,
            ...(input.unresolvedItems === undefined ? {} : { unresolvedItems: input.unresolvedItems }),
            ...(input.finalSummary === undefined ? {} : { finalSummary: input.finalSummary }),
            authorization: {
              agentName: authorization.agentName,
              sessionRole: authorization.sessionRole,
              sessionGoalId: authorization.sessionGoalId,
              reviewerSessionId: authorization.sessionId,
            },
          }));
        }
        case "retry": {
          return formatGoalToolResult(await manager.retry(input.goalId, { mainSessionId: authorization.sessionId }));
        }
        case "cancel": {
          return formatGoalToolResult(await manager.cancel(input.goalId, input.reason));
        }
      }
    } catch (error) {
      return goalToolErrorResult(error, {
        stateErrorCode: input.action === "finalize_review" ? "GOAL_REVIEW_PHASE_REQUIRED" : "GOAL_INVALID_TRANSITION",
      });
    }
  },
});

function simplifiedGoalStateManager(ctx: ToolExecutionContext): SimplifiedGoalStateManager {
  return ctx.projectContext.goalState as unknown as SimplifiedGoalStateManager;
}

export { GoalManageInputSchema };
