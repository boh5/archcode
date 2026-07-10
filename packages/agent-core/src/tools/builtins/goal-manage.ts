import { z } from "zod/v4";
import { resolve } from "node:path";
import {
  TOOL_GOAL_MANAGE,
  type GoalBlockerKind,
  type GoalEvidenceRef,
  type GoalReviewVerdict,
  type GoalState,
} from "@archcode/protocol";

import { defineTool } from "../define-tool";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import { withGoalExecutionClaimLock } from "../../goals/execution-claim";
import { GoalCancellationCleanupError } from "../../goals/cancellation";
import { GoalUuidSchema } from "../../goals/state";
import { WorktreeService } from "../../worktrees";
import {
  assertGoalManageActionAuthorized,
  formatGoalToolResult,
  GoalToolAuthorizationError,
  goalToolErrorResult,
} from "./goal-tools/helpers";

const GoalTextSchema = z.string().trim().min(1);
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
  objective: GoalLongMarkdownSchema.describe("Natural-language objective for the Goal."),
  acceptanceCriteria: GoalLongMarkdownSchema.describe("Natural-language acceptance criteria for Reviewer judgment."),
  useWorktree: z.boolean().optional()
    .describe("Whether this Goal should execute in a dedicated managed Git worktree. Defaults to false."),
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
  read(goalId: string): Promise<GoalState>;
  create(input: {
    projectId: string;
    objective: string;
    acceptanceCriteria: string;
    useWorktree?: boolean;
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
            objective: input.objective,
            acceptanceCriteria: input.acceptanceCriteria,
            ...(input.useWorktree === undefined ? {} : { useWorktree: input.useWorktree }),
          }));
        }
        case "start": {
          await assertGoalExecutionWorkspace(manager, input.goalId, ctx);
          return formatGoalToolResult(await withGoalExecutionClaimLock(
            input.goalId,
            () => manager.start(input.goalId, { mainSessionId: authorization.sessionId }),
          ));
        }
        case "block": {
          return formatGoalToolResult(await withGoalExecutionClaimLock(input.goalId, () => (
            manager.block(input.goalId, {
              kind: input.kind,
              summary: input.summary,
              ...(input.hitlId === undefined ? {} : { hitlId: input.hitlId }),
              ...(input.source === undefined ? {} : { source: input.source }),
              ...(input.resumeStatus === undefined ? {} : { resumeStatus: input.resumeStatus }),
            })
          )));
        }
        case "resume": {
          await assertGoalExecutionWorkspace(manager, input.goalId, ctx);
          return formatGoalToolResult(await withGoalExecutionClaimLock(
            input.goalId,
            () => manager.clearBlocker(input.goalId, input.hitlId),
          ));
        }
        case "begin_review": {
          await assertGoalExecutionWorkspace(manager, input.goalId, ctx);
          return formatGoalToolResult(await withGoalExecutionClaimLock(
            input.goalId,
            () => manager.beginReview(input.goalId),
          ));
        }
        case "finalize_review": {
          await assertGoalExecutionWorkspace(manager, input.goalId, ctx);
          return formatGoalToolResult(await withGoalExecutionClaimLock(input.goalId, () => (
            manager.finalizeReview(input.goalId, {
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
            })
          )));
        }
        case "retry": {
          await assertGoalExecutionWorkspace(manager, input.goalId, ctx);
          return formatGoalToolResult(await withGoalExecutionClaimLock(
            input.goalId,
            () => manager.retry(input.goalId, { mainSessionId: authorization.sessionId }),
          ));
        }
        case "cancel": {
          const cancellation = ctx.projectContext.goalCancellation;
          if (cancellation === undefined) {
            throw new GoalToolAuthorizationError(
              "GOAL_CANCELLATION_UNAVAILABLE",
              "Goal cancellation service is unavailable in this runtime",
            );
          }
          let cancelled: GoalState;
          try {
            cancelled = await cancellation.cancel(input.goalId, {
              source: "agent",
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              selfSessionId: authorization.sessionId,
            });
          } catch (error) {
            if (!(error instanceof GoalCancellationCleanupError)) throw error;
            const result = goalToolErrorResult(error);
            return {
              ...result,
              meta: {
                ...result.meta,
                executionControl: {
                  action: "stop_session_family",
                  reason: "goal_cancelled_cleanup_incomplete",
                },
              },
            };
          }
          return {
            output: formatGoalToolResult(cancelled),
            isError: false,
            meta: {
              executionControl: {
                action: "stop_session_family",
                reason: "goal_cancelled",
              },
            },
          };
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

async function assertGoalExecutionWorkspace(
  manager: SimplifiedGoalStateManager,
  goalId: string,
  ctx: ToolExecutionContext,
): Promise<void> {
  const goal = await manager.read(goalId);
  if (goal.useWorktree !== true) return;
  if (goal.worktree === undefined) {
    throw new GoalToolAuthorizationError(
      "GOAL_WORKTREE_REQUIRED",
      `Goal ${goalId} requires its managed worktree to be prepared by the runtime before execution`,
    );
  }
  if (resolve(ctx.cwd) !== resolve(goal.worktree.path)) {
    throw new GoalToolAuthorizationError(
      "GOAL_WORKTREE_MISMATCH",
      `Goal ${goalId} must execute in ${goal.worktree.path}, got ${ctx.cwd}`,
    );
  }
  try {
    await new WorktreeService({
      canonicalRoot: ctx.projectContext.project.workspaceRoot,
    }).validateManagedClaim({
      path: goal.worktree.path,
      branchName: goal.worktree.branchName,
      mode: "persisted",
      baseSha: goal.worktree.baseSha,
    });
  } catch (error) {
    throw new GoalToolAuthorizationError(
      "GOAL_WORKTREE_CHANGED",
      `Goal ${goalId} managed worktree claim is no longer valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export { GoalManageInputSchema };
