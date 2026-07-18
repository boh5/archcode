import { z } from "zod/v4";
import { resolve } from "node:path";
import {
  TOOL_GOAL_MANAGE,
  type GoalReviewVerdict,
  type GoalState,
} from "@archcode/protocol";

import { defineTool } from "../define-tool";
import type { AnyToolDescriptor, ToolExecutionContext } from "../types";
import { GoalCancellationCleanupError } from "../../goals/cancellation";
import { GoalUuidSchema } from "../../goals/state";
import { GoalReviewReceiptSchema, GoalReviewSummarySchema, projectGoalReviewReceipt } from "../../goals/review-schema";
import { ChildResultSchema } from "../../delegation/schema";
import { validateChildResultAgainstContract } from "../../delegation/contract";
import { WorktreeService } from "../../worktrees";
import {
  assertGoalManageActionAuthorized,
  formatGoalToolResult,
  GoalToolAuthorizationError,
  goalToolErrorResult,
} from "./goal-tools/helpers";

const GoalTextSchema = z.string().trim().min(1);

const GoalManageBeginReviewInputSchema = z.strictObject({
  action: z.literal("begin_review"),
  goalId: GoalUuidSchema.describe("Goal UUID whose execution should move into review."),
});

const GoalManageFinalizeReviewInputSchema = z.strictObject({
  action: z.literal("finalize_review"),
  goalId: GoalUuidSchema.describe("Goal UUID whose Reviewer receipt should be recorded."),
  expectedReviewGeneration: GoalReviewReceiptSchema.shape.reviewGeneration.describe("Review generation observed by this Reviewer session."),
  verdict: GoalReviewReceiptSchema.shape.verdict satisfies z.ZodType<GoalReviewVerdict>,
  summary: GoalReviewReceiptSchema.shape.summary.describe("Reviewer result summary."),
  evidenceRefs: GoalReviewReceiptSchema.shape.evidenceRefs.describe("Evidence references supporting the verdict."),
  unresolvedItems: GoalReviewReceiptSchema.shape.unresolvedItems,
  finalSummary: GoalReviewSummarySchema.optional(),
  result: ChildResultSchema.describe("Canonical delegated-task result for this review execution."),
});

const GoalManageRetryInputSchema = z.strictObject({
  action: z.literal("retry"),
  goalId: GoalUuidSchema.describe("Goal UUID to retry."),
});

const GoalManageCancelInputSchema = z.strictObject({
  action: z.literal("cancel"),
  goalId: GoalUuidSchema.describe("Goal UUID to cancel."),
  reason: GoalReviewSummarySchema.optional(),
});

const GoalManageInputSchema = z.discriminatedUnion("action", [
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

interface GoalStateReader {
  read(goalId: string): Promise<GoalState>;
}

export const goalManageTool: AnyToolDescriptor = defineTool({
  name: TOOL_GOAL_MANAGE,
  description: "Manage a Goal lifecycle: begin_review, finalize_review, retry, or cancel.",
  inputSchema: GoalManageInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input: GoalManageInput, ctx: ToolExecutionContext) => {
    try {
      const authorization = assertGoalManageActionAuthorized(
        input.action,
        ctx,
        input.goalId,
      );
      const state = ctx.projectContext.goalState;
      const lifecycle = ctx.projectContext.goalLifecycle;
      if (input.action !== "finalize_review") {
        await assertCurrentGoalLeadMain(state, input.goalId, authorization.sessionId, input.action);
      }

      switch (input.action) {
        case "begin_review": {
          await assertGoalExecutionWorkspace(state, input.goalId, ctx);
          return formatGoalToolResult(await lifecycle.beginReview(
            input.goalId,
            () => assertNoActiveBuildChild(ctx),
          ));
        }
        case "finalize_review": {
          await assertGoalExecutionWorkspace(state, input.goalId, ctx);
          const session = ctx.store.getState();
          const executionId = session.currentExecutionId;
          const delegationContractHash = session.delegationContractHash;
          const delegationContract = session.delegationContract;
          if (executionId === undefined || delegationContractHash === undefined || delegationContract === undefined) {
            throw new GoalToolAuthorizationError(
              "GOAL_REVIEW_EXECUTION_IDENTITY_REQUIRED",
              "goal_manage.finalize_review requires the current Reviewer execution and durable delegation contract",
            );
          }
          try {
            validateChildResultAgainstContract(input.result, delegationContract);
            if (input.verdict === "DONE" && input.result.status !== "completed") {
              throw new Error("goal_manage.finalize_review with DONE requires a completed ChildResult");
            }
          } catch (error) {
            const resultError = new GoalToolAuthorizationError(
              "GOAL_REVIEW_RESULT_INVALID",
              error instanceof Error ? error.message : String(error),
            );
            if (ctx.structuredResultCorrection?.submission === "goal_manage.finalize_review") {
              return ctx.structuredResultCorrection.recordFailure(resultError);
            }
            throw resultError;
          }
          const finalized = await lifecycle.finalizeReview(input.goalId, {
            executionId,
            delegationContractHash,
            expectedReviewGeneration: input.expectedReviewGeneration,
            verdict: input.verdict,
            summary: input.summary,
            evidenceRefs: input.evidenceRefs,
            ...(input.unresolvedItems === undefined ? {} : { unresolvedItems: input.unresolvedItems }),
            ...(input.finalSummary === undefined ? {} : { finalSummary: input.finalSummary }),
            result: input.result,
            authorization: {
              agentName: authorization.agentName,
              sessionRole: authorization.sessionRole,
              sessionGoalId: authorization.sessionGoalId,
              reviewerSessionId: authorization.sessionId,
            },
          });
          if (finalized.review === undefined) {
            throw new Error(`Goal ${input.goalId} finalized without a canonical review receipt`);
          }
          ctx.store.getState().append({
            type: "child-result",
            receipt: projectGoalReviewReceipt(finalized.review),
          });
          return formatGoalToolResult(finalized, {
              executionControl: {
                action: "complete_execution",
                reason: "goal_review_finalized",
              },
          });
        }
        case "retry": {
          await assertGoalExecutionWorkspace(state, input.goalId, ctx);
          return formatGoalToolResult(await lifecycle.retry(input.goalId));
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
              sidecar: {
                executionControl: {
                  action: "stop_session_family",
                  reason: "goal_cancelled",
                },
              },
            };
          }
          return formatGoalToolResult(cancelled, {
              executionControl: {
                action: "stop_session_family",
                reason: "goal_cancelled",
              },
          });
        }
      }
    } catch (error) {
      return goalToolErrorResult(error, {
        stateErrorCode: input.action === "finalize_review" ? "GOAL_REVIEW_PHASE_REQUIRED" : "GOAL_INVALID_TRANSITION",
      });
    }
  },
});

async function assertNoActiveBuildChild(ctx: ToolExecutionContext): Promise<void> {
  const workspaceRoot = ctx.projectContext.project.workspaceRoot;
  const stores = [ctx.store];
  const visited = new Set<string>();
  while (stores.length > 0) {
    const store = stores.shift()!;
    const state = store.getState();
    if (visited.has(state.sessionId)) continue;
    visited.add(state.sessionId);
    for (const link of state.childSessionLinks) {
      if (
        link.childAgentName === "build"
        && (link.status === "linked" || link.status === "running" || link.status === "waiting_for_human")
      ) {
        throw new GoalToolAuthorizationError(
          "GOAL_BUILD_ACTIVE",
          `goal_manage.begin_review requires all Build children to finish; ${link.childSessionId} is ${link.status}`,
        );
      }
      stores.push(await ctx.storeManager.getOrLoad(link.childSessionId, workspaceRoot));
    }
  }
}

async function assertGoalExecutionWorkspace(
  manager: GoalStateReader,
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

async function assertCurrentGoalLeadMain(
  manager: GoalStateReader,
  goalId: string,
  sessionId: string,
  action: Exclude<GoalManageInput["action"], "finalize_review">,
): Promise<void> {
  const goal = await manager.read(goalId);
  if (goal.mainSessionId === sessionId) return;
  throw new GoalToolAuthorizationError(
    "GOAL_CONTEXT_REQUIRED",
    `goal_manage.${action} requires current main Session ${goal.mainSessionId ?? "unassigned"}, got ${sessionId}`,
  );
}

export { GoalManageInputSchema };
