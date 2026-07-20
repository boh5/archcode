import {
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  SESSION_GOAL_REVIEW_PHASES,
  SESSION_GOAL_STATUSES,
} from "@archcode/protocol";
import { z } from "zod/v4";
import { ChildResultSchema, DelegationContractSchema } from "../delegation/schema";

const NON_EMPTY = z.string().trim().min(1);
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const NON_NEGATIVE_SAFE_INT = z.number().int().nonnegative().safe();

export const SessionGoalObjectiveSchema = z.string()
  .trim()
  .min(1)
  .max(SESSION_GOAL_OBJECTIVE_MAX_LENGTH);


export const SessionGoalUsageSchema = z.strictObject({
  tokens: z.strictObject({
    inputTokens: NON_NEGATIVE_SAFE_INT,
    outputTokens: NON_NEGATIVE_SAFE_INT,
    totalTokens: NON_NEGATIVE_SAFE_INT,
    reasoningTokens: NON_NEGATIVE_SAFE_INT,
    cachedInputTokens: NON_NEGATIVE_SAFE_INT,
  }),
  executionTimeMs: NON_NEGATIVE_SAFE_INT,
  executionCount: NON_NEGATIVE_SAFE_INT,
});

export const SessionGoalEvaluatorResultSchema = z.strictObject({
  decision: z.enum(["continue", "candidate_complete"]),
  reason: NON_EMPTY,
  evaluatedAt: NON_NEGATIVE_SAFE_INT,
});

export const SessionGoalReviewClaimSchema = z.strictObject({
  claimId: z.string().uuid(),
  instanceId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  objective: SessionGoalObjectiveSchema,
  requestedBy: z.enum(["engineer", "evaluator"]),
  reason: NON_EMPTY,
  reviewContract: DelegationContractSchema,
  reviewContractHash: SHA256,
  userInputCursor: NON_NEGATIVE_SAFE_INT,
  sourceMutationEpoch: NON_NEGATIVE_SAFE_INT,
  sourceFingerprint: SHA256,
  createdAt: NON_NEGATIVE_SAFE_INT,
}).superRefine((claim, ctx) => {
  if (claim.reviewContract.agent_type !== "reviewer") {
    ctx.addIssue({ code: "custom", path: ["reviewContract", "agent_type"], message: "Goal review contract must target reviewer" });
  }
});

export const SessionGoalReviewReceiptSchema = z.strictObject({
  claimId: z.string().uuid(),
  attempt: z.number().int().positive().safe(),
  reviewerSessionId: NON_EMPTY,
  reviewerExecutionId: NON_EMPTY,
  verdict: z.enum(["accepted", "rejected"]),
  summary: NON_EMPTY,
  result: ChildResultSchema,
  decidedAt: NON_NEGATIVE_SAFE_INT,
});

export const SessionGoalReviewStateSchema = z.strictObject({
  phase: z.enum(SESSION_GOAL_REVIEW_PHASES),
  claim: SessionGoalReviewClaimSchema,
  attempt: z.number().int().positive().safe(),
  reviewerSessionId: NON_EMPTY.optional(),
  reviewerExecutionId: NON_EMPTY.optional(),
  receipt: SessionGoalReviewReceiptSchema.optional(),
  remediationReason: NON_EMPTY.optional(),
  remediationExecutionId: NON_EMPTY.optional(),
}).superRefine((review, ctx) => {
  const runningReview = review.phase === "review_running";
  if (runningReview !== (review.reviewerSessionId !== undefined && review.reviewerExecutionId !== undefined)) {
    ctx.addIssue({ code: "custom", message: "review_running requires exactly one Reviewer Session and Execution" });
  }
  const remediation = review.phase === "remediation_required" || review.phase === "remediation_running";
  if (remediation !== (review.receipt?.verdict === "rejected" && review.remediationReason !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Remediation phases require a rejected receipt and reason" });
  }
  if ((review.phase === "remediation_running") !== (review.remediationExecutionId !== undefined)) {
    ctx.addIssue({ code: "custom", message: "remediation_running requires exactly one remediation Execution" });
  }
  if (review.receipt !== undefined
    && (review.receipt.claimId !== review.claim.claimId || review.receipt.attempt !== review.attempt)) {
    ctx.addIssue({ code: "custom", path: ["receipt"], message: "Review receipt does not match claim and attempt" });
  }
});

export const SessionGoalSchema = z.strictObject({
  instanceId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  objective: SessionGoalObjectiveSchema,
  status: z.enum(SESSION_GOAL_STATUSES),
  tokenBudget: z.number().int().positive().safe().optional(),
  usage: SessionGoalUsageSchema,
  evaluatorCount: NON_NEGATIVE_SAFE_INT,
  lastEvaluator: SessionGoalEvaluatorResultSchema.optional(),
  noProgressCount: NON_NEGATIVE_SAFE_INT,
  blockerCandidate: z.strictObject({
    reason: NON_EMPTY,
    consecutiveTurns: z.number().int().positive().safe(),
    lastExecutionId: NON_EMPTY,
  }).optional(),
  failureCount: NON_NEGATIVE_SAFE_INT,
  nextRetryAt: NON_NEGATIVE_SAFE_INT.optional(),
  userInputCursor: NON_NEGATIVE_SAFE_INT,
  sourceMutationEpoch: NON_NEGATIVE_SAFE_INT,
  review: SessionGoalReviewStateSchema.optional(),
  lastReviewReceipt: SessionGoalReviewReceiptSchema.optional(),
  blockedReason: NON_EMPTY.optional(),
  createdAt: NON_NEGATIVE_SAFE_INT,
  activatedAt: NON_NEGATIVE_SAFE_INT,
  updatedAt: NON_NEGATIVE_SAFE_INT,
  pausedAt: NON_NEGATIVE_SAFE_INT.optional(),
  completedAt: NON_NEGATIVE_SAFE_INT.optional(),
}).superRefine((goal, ctx) => {
  if (goal.usage.tokens.totalTokens !== goal.usage.tokens.inputTokens + goal.usage.tokens.outputTokens) {
    ctx.addIssue({ code: "custom", path: ["usage", "tokens", "totalTokens"], message: "totalTokens must equal inputTokens + outputTokens" });
  }
  if (goal.status === "paused" && goal.pausedAt === undefined) {
    ctx.addIssue({ code: "custom", path: ["pausedAt"], message: "pausedAt must exist while paused" });
  }
  if (goal.pausedAt !== undefined && goal.status !== "paused" && goal.status !== "budget_limited") {
    ctx.addIssue({ code: "custom", path: ["pausedAt"], message: "pausedAt is valid only while paused or budget limited" });
  }
  if ((goal.status === "complete") !== (goal.completedAt !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["completedAt"], message: "completedAt must exist exactly while complete" });
  }
  if (goal.status === "blocked" && goal.blockedReason === undefined) {
    ctx.addIssue({ code: "custom", path: ["blockedReason"], message: "blockedReason must exist while blocked" });
  }
  if (goal.blockedReason !== undefined && goal.status !== "blocked" && goal.status !== "budget_limited") {
    ctx.addIssue({ code: "custom", path: ["blockedReason"], message: "blockedReason is valid only while blocked or budget limited" });
  }
  if (goal.review !== undefined
    && (goal.review.claim.instanceId !== goal.instanceId
      || goal.review.claim.generation !== goal.generation
      || goal.review.claim.objective !== goal.objective)) {
    ctx.addIssue({ code: "custom", path: ["review", "claim"], message: "Review claim does not match the current Goal contract" });
  }
  if (goal.status === "complete" && goal.lastReviewReceipt?.verdict !== "accepted") {
    ctx.addIssue({ code: "custom", path: ["lastReviewReceipt"], message: "A complete Goal requires an accepted Review receipt" });
  }
});

export type ParsedSessionGoal = z.output<typeof SessionGoalSchema>;
