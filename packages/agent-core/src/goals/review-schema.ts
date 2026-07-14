import type {
  GoalEvidenceRef as ProtocolGoalEvidenceRef,
  GoalReviewReceipt as ProtocolGoalReviewReceipt,
} from "@archcode/protocol";
import { z } from "zod/v4";

export const GoalEvidenceSummarySchema = z.string().trim().min(1).max(1_000);
export const GoalReviewSummarySchema = z.string().trim().min(1).max(4_000);

export const GoalEvidenceRefSchema = z.strictObject({
  kind: z.enum(["session", "message", "tool_call", "diff", "test_output", "file", "url", "hitl"]),
  ref: z.string().trim().min(1),
  summary: GoalEvidenceSummarySchema,
  sessionId: z.string().trim().min(1).optional(),
  messageId: z.string().trim().min(1).optional(),
  toolCallId: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  url: z.url().optional(),
  createdAt: z.string().trim().min(1).optional(),
}) satisfies z.ZodType<ProtocolGoalEvidenceRef>;

export const GoalReviewReceiptSchema = z.strictObject({
  reviewGeneration: z.number().int().nonnegative(),
  verdict: z.enum(["DONE", "NOT_DONE"]),
  summary: GoalReviewSummarySchema,
  evidenceRefs: z.array(GoalEvidenceRefSchema).max(20),
  unresolvedItems: z.array(z.string().trim().min(1).max(1_000)).max(20).optional(),
  reviewerSessionId: z.string().trim().min(1),
  decidedAt: z.string().datetime({ offset: true }),
}) satisfies z.ZodType<ProtocolGoalReviewReceipt>;
