import type { Logger } from "../logger";
import type { ModelRuntime, ModelSelectionResolver } from "../models";
import type { PermissionDecision, ToolExecutionContext } from "../tools/types";

export const APPROVAL_REVIEW_DEFER_REASONS = [
  "disabled",
  "ask_user",
  "sensitive_input",
  "input_too_large",
  "context_too_large",
  "context_unavailable",
  "model_unavailable",
  "timeout",
  "provider_error",
  "schema_error",
] as const;

export type ApprovalReviewDeferReason = typeof APPROVAL_REVIEW_DEFER_REASONS[number];

export interface ApprovalReviewRequest {
  readonly context: ToolExecutionContext;
  /** Registry passes the unresolved decision; Service verifies it is still an ask. */
  readonly permission: PermissionDecision;
  /** Exact post-prepareInput, post-before-hook input that would be executed. */
  readonly input: unknown;
}

export type ApprovalReviewOutcome =
  | { readonly outcome: "approved" }
  | { readonly outcome: "deferred"; readonly reason: ApprovalReviewDeferReason };

export interface ApprovalReviewer {
  review(request: ApprovalReviewRequest): Promise<ApprovalReviewOutcome>;
}

export interface ApprovalReviewRedactionPolicy {
  redactString(value: string): string;
}

export interface ApprovalReviewServiceOptions {
  readonly modelRuntime: ModelRuntime;
  readonly modelSelectionResolver: ModelSelectionResolver;
  readonly isEnabled: () => boolean;
  readonly redactionPolicy: ApprovalReviewRedactionPolicy;
  readonly logger?: Logger;
  readonly now?: () => number;
}

export interface ApprovalReviewLogRecord {
  readonly outcome: ApprovalReviewOutcome["outcome"];
  readonly deferReason?: ApprovalReviewDeferReason;
  readonly latencyMs: number;
  readonly binding?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly modelRuntimeRevision: string;
  };
  readonly usage: ApprovalReviewUsageLog;
}

/** Secret-key-safe projection of normalized usage for the Runtime log boundary. */
export interface ApprovalReviewUsageLog {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly reasoning: number;
  readonly cachedInput: number;
}
