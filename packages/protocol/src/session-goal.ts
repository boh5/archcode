import type { ChildResult, DelegationContract } from "./delegation";
import type { NormalizedUsage } from "./types";

export const SESSION_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;

export const SESSION_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
] as const;

export type SessionGoalStatus = typeof SESSION_GOAL_STATUSES[number];

export const SESSION_GOAL_REVIEW_PHASES = [
  "requested",
  "review_running",
  "remediation_required",
  "remediation_running",
] as const;

export type SessionGoalReviewPhase = typeof SESSION_GOAL_REVIEW_PHASES[number];

export interface SessionGoalUsage {
  tokens: NormalizedUsage;
  executionTimeMs: number;
  executionCount: number;
}

export interface SessionGoalEvaluatorResult {
  decision: "continue" | "candidate_complete";
  reason: string;
  evaluatedAt: number;
}

export interface SessionGoalBlockerCandidate {
  reason: string;
  consecutiveTurns: number;
  lastExecutionId: string;
}

/** Immutable basis fenced at the instant Runtime accepts a completion claim. */
export interface SessionGoalReviewClaim {
  claimId: string;
  instanceId: string;
  generation: number;
  objective: string;
  requestedBy: "engineer" | "evaluator";
  reason: string;
  reviewContract: DelegationContract;
  reviewContractHash: string;
  userInputCursor: number;
  sourceMutationEpoch: number;
  sourceFingerprint: string;
  createdAt: number;
}

export interface SessionGoalReviewReceipt {
  claimId: string;
  attempt: number;
  reviewerSessionId: string;
  reviewerExecutionId: string;
  verdict: "accepted" | "rejected";
  summary: string;
  result: ChildResult;
  decidedAt: number;
}

export interface SessionGoalReviewState {
  phase: SessionGoalReviewPhase;
  claim: SessionGoalReviewClaim;
  attempt: number;
  reviewerSessionId?: string;
  reviewerExecutionId?: string;
  receipt?: SessionGoalReviewReceipt;
  remediationReason?: string;
  remediationExecutionId?: string;
}

export interface SessionGoal {
  instanceId: string;
  generation: number;
  objective: string;
  status: SessionGoalStatus;
  tokenBudget?: number;
  usage: SessionGoalUsage;
  evaluatorCount: number;
  lastEvaluator?: SessionGoalEvaluatorResult;
  noProgressCount: number;
  blockerCandidate?: SessionGoalBlockerCandidate;
  failureCount: number;
  nextRetryAt?: number;
  userInputCursor: number;
  sourceMutationEpoch: number;
  review?: SessionGoalReviewState;
  lastReviewReceipt?: SessionGoalReviewReceipt;
  /** Blocking state retained while a higher-priority budget gate is visible. */
  blockedReason?: string;
  createdAt: number;
  activatedAt: number;
  updatedAt: number;
  /** User pause intent; retained while a higher-priority budget gate is visible. */
  pausedAt?: number;
  completedAt?: number;
}

export const SESSION_GOAL_CHANGE_ACTIONS = [
  "created",
  "edited",
  "paused",
  "resumed",
  "cleared",
  "budget_updated",
  "blocked",
  "blocked_evidence_recorded",
  "usage_recorded",
  "evaluator_recorded",
  "review_requested",
  "review_started",
  "review_restarted",
  "review_rejected",
  "remediation_started",
  "remediation_rebound",
  "remediation_retry_requested",
  "remediation_finished",
  "runtime_failed",
  "completed",
] as const;

export type SessionGoalChangeAction = typeof SESSION_GOAL_CHANGE_ACTIONS[number];

/**
 * Durable Session event with the canonical post-mutation Goal snapshot.
 *
 * `null` is deliberately used for a clear instead of `undefined`: events cross
 * the SSE JSON boundary, where `undefined` properties disappear. Keeping the
 * snapshot in the event makes reducer replay isomorphic for the runtime and
 * Web stores rather than forcing either side to fetch opportunistically.
 */
export interface SessionGoalChangedEvent {
  type: "session.goal_changed";
  action: SessionGoalChangeAction;
  instanceId: string;
  generation: number;
  goal: SessionGoal | null;
  status?: SessionGoalStatus;
  reason?: string;
  occurredAt: number;
}
