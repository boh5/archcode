import {
  addUsage,
  createEmptySessionStats,
  type DelegationContract,
  type ExecutionEndEvent,
  type NormalizedUsage,
  type SessionGoal,
  type SessionGoalChangedEvent,
  type SessionGoalEvaluatorResult,
  type SessionGoalReviewReceipt,
} from "@archcode/protocol";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import { hashDelegationContract } from "../delegation/contract";
import { SessionGoalObjectiveSchema, SessionGoalSchema } from "./schema";

export type SessionGoalAuthority =
  | { readonly kind: "user_control" }
  | { readonly kind: "agent" }
  | { readonly kind: "runtime" };

export interface SessionGoalTarget {
  readonly workspaceRoot: string;
  readonly sessionId: string;
}

export class SessionGoalServiceError extends Error {
  constructor(
    public readonly code:
      | "NOT_ROOT_ENGINEER"
      | "GOAL_NOT_FOUND"
      | "GOAL_ALREADY_ACTIVE"
      | "GOAL_TERMINAL"
      | "GENERATION_CONFLICT"
      | "INVALID_TRANSITION"
      | "AUTHORITY_DENIED"
      | "REVIEW_BASIS_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SessionGoalServiceError";
  }
}

export class SessionGoalService {
  constructor(private readonly sessions: SessionStoreManager) {}

  async get(target: SessionGoalTarget): Promise<SessionGoal | undefined> {
    return (await this.sessions.getSessionFile(target.workspaceRoot, target.sessionId)).goal;
  }

  async create(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly objective: string;
    readonly tokenBudget?: number;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    const objective = SessionGoalObjectiveSchema.parse(input.objective);
    return await this.mutate(input, (state, now) => {
      assertRootEngineer(state);
      if (state.goal !== undefined && state.goal.status !== "complete") {
        throw new SessionGoalServiceError("GOAL_ALREADY_ACTIVE", "A non-terminal Goal already exists");
      }
      const goal = checkedGoal({
        instanceId: crypto.randomUUID(),
        generation: 1,
        objective,
        status: "active",
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: positiveInt(input.tokenBudget, "tokenBudget") }),
        usage: { tokens: createEmptySessionStats().usage, executionTimeMs: 0, executionCount: 0 },
        evaluatorCount: 0,
        noProgressCount: 0,
        failureCount: 0,
        userInputCursor: 0,
        sourceMutationEpoch: 0,
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
      });
      return change(goal, "created", now);
    });
  }

  async edit(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly expectedGeneration: number;
    readonly objective: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    const objective = SessionGoalObjectiveSchema.parse(input.objective);
    return await this.mutate(input, (state, now) => {
      const current = activeGoal(state, input.expectedGeneration);
      const goal = checkedGoal({
        ...current,
        generation: current.generation + 1,
        objective,
        evaluatorCount: 0,
        lastEvaluator: undefined,
        noProgressCount: 0,
        blockerCandidate: undefined,
        failureCount: 0,
        nextRetryAt: undefined,
        review: undefined,
        lastReviewReceipt: undefined,
        updatedAt: now,
      });
      return change(goal, "edited", now);
    });
  }

  async pause(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    return await this.mutate(input, (state, now) => {
      const current = nonTerminalGoal(state);
      if (current.status === "paused") return unchanged(current);
      if (current.status === "budget_limited") {
        if (current.pausedAt !== undefined) return unchanged(current);
        return change(checkedGoal({
          ...current,
          // Budget remains the visible/actionable gate. This timestamp records
          // that a concurrent Stop must still be honored after the budget is
          // raised or removed.
          pausedAt: now,
          updatedAt: now,
        }), "paused", now);
      }
      if (current.status !== "active") {
        throw new SessionGoalServiceError("INVALID_TRANSITION", `Cannot pause Goal from ${current.status}`);
      }
      return change(checkedGoal({
        ...current,
        status: "paused",
        pausedAt: now,
        blockedReason: undefined,
        updatedAt: now,
      }), "paused", now);
    });
  }

  async resume(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    return await this.mutate(input, (state, now) => {
      const current = nonTerminalGoal(state);
      if (current.status !== "paused" && current.status !== "blocked" && current.status !== "budget_limited") {
        throw new SessionGoalServiceError("INVALID_TRANSITION", `Cannot resume Goal from ${current.status}`);
      }
      if (current.tokenBudget !== undefined && current.usage.tokens.totalTokens >= current.tokenBudget) {
        throw new SessionGoalServiceError("INVALID_TRANSITION", "Increase the token budget before resuming");
      }
      return change(checkedGoal({
        ...current,
        status: "active",
        pausedAt: undefined,
        blockedReason: undefined,
        blockerCandidate: undefined,
        failureCount: 0,
        nextRetryAt: undefined,
        noProgressCount: 0,
        updatedAt: now,
      }), "resumed", now);
    });
  }

  async clear(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<void> {
    requireAuthority(input.authority, "user_control");
    await this.sessions.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootEngineer(state);
      const goal = requiredGoal(state);
      const occurredAt = Date.now();
      return {
        result: undefined,
        patch: { goal: undefined },
        events: [eventFor(goal, "cleared", occurredAt)],
      };
    });
  }

  async setTokenBudget(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly tokenBudget?: number;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    return await this.mutate(input, (state, now) => {
      const current = nonTerminalGoal(state);
      const tokenBudget = input.tokenBudget === undefined ? undefined : positiveInt(input.tokenBudget, "tokenBudget");
      const exhausted = tokenBudget !== undefined && current.usage.tokens.totalTokens >= tokenBudget;
      const status = exhausted
        ? "budget_limited" as const
        : current.status === "budget_limited" && !exhausted
          ? current.pausedAt !== undefined
            ? "paused" as const
            : current.blockedReason !== undefined
              ? "blocked" as const
              : "active" as const
          : current.status;
      return change(checkedGoal({
        ...current,
        tokenBudget,
        status,
        updatedAt: now,
      }), "budget_updated", now);
    });
  }

  async recordUsage(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly usage: NormalizedUsage;
    readonly executionTimeMs: number;
    readonly outcome?: ExecutionEndEvent["status"];
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.mutate(input, (state, now) => {
      const current = nonTerminalGoal(state);
      const tokens = addUsage(current.usage.tokens, input.usage);
      // Usage is settled after an Execution ends. A user Stop can persist the
      // pause before that settlement arrives, so budget enforcement must not
      // depend on the pre-settlement display status. `pausedAt` retains the
      // user's pause intent while the actionable budget gate takes priority.
      const budgetLimited = current.tokenBudget !== undefined
        && tokens.totalTokens >= current.tokenBudget;
      const outcomeRecorded = input.outcome !== undefined;
      const failed = input.outcome === "failed" || input.outcome === "timed_out" || input.outcome === "max_steps";
      const failureCount = !outcomeRecorded ? current.failureCount : failed ? current.failureCount + 1 : 0;
      const exhausted = current.status === "active" && failureCount >= 3;
      const nextRetryAt = !outcomeRecorded
        ? current.nextRetryAt
        : failed && !exhausted
          ? now + Math.min(250 * 2 ** Math.max(0, failureCount - 1), 4_000)
          : undefined;
      const goal = checkedGoal({
        ...current,
        status: budgetLimited ? "budget_limited" : exhausted ? "blocked" : current.status,
        failureCount,
        nextRetryAt,
        blockedReason: exhausted ? "Execution failed repeatedly" : current.blockedReason,
        usage: {
          tokens,
          executionTimeMs: current.usage.executionTimeMs + nonNegativeInt(input.executionTimeMs, "executionTimeMs"),
          executionCount: current.usage.executionCount + 1,
        },
        updatedAt: now,
      });
      return change(goal, exhausted ? "blocked" : "usage_recorded", now, exhausted ? goal.blockedReason : undefined);
    });
  }

  async recordEvaluatorDecision(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly decision: SessionGoalEvaluatorResult["decision"];
    readonly reason: string;
    readonly madeProgress: boolean;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.mutate(input, (state, now) => {
      const current = requireActiveGoal(state);
      const reason = requiredText(input.reason, "reason");
      const goal = checkedGoal({
        ...current,
        evaluatorCount: current.evaluatorCount + 1,
        lastEvaluator: { decision: input.decision, reason, evaluatedAt: now },
        // `reason` is model-authored display text and cannot be a stable retry key.
        // Count every consecutive no-progress decision so paraphrasing cannot
        // keep an active Goal running forever.
        noProgressCount: input.madeProgress ? 0 : current.noProgressCount + 1,
        updatedAt: now,
      });
      return change(goal, "evaluator_recorded", now, reason);
    });
  }

  async recordBlockedTurn(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly reason: string;
    readonly executionId: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "agent");
    return await this.mutate(input, (state, now) => {
      const current = requireActiveGoal(state);
      const reason = requiredText(input.reason, "reason");
      const executionId = requiredText(input.executionId, "executionId");
      if (current.blockerCandidate?.lastExecutionId === executionId) return unchanged(current);
      const consecutiveTurns = current.blockerCandidate?.reason === reason
        ? current.blockerCandidate.consecutiveTurns + 1
        : 1;
      const blocked = consecutiveTurns >= 3;
      const goal = checkedGoal({
        ...current,
        status: blocked ? "blocked" : current.status,
        blockerCandidate: { reason, consecutiveTurns, lastExecutionId: executionId },
        blockedReason: blocked ? reason : undefined,
        updatedAt: now,
      });
      return change(goal, blocked ? "blocked" : "blocked_evidence_recorded", now, reason);
    });
  }

  async blockForNoProgress(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly reason: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.mutate(input, (state, now) => {
      const current = requireActiveGoal(state);
      const reason = requiredText(input.reason, "reason");
      return change(checkedGoal({
        ...current,
        status: "blocked",
        blockedReason: reason,
        updatedAt: now,
      }), "blocked", now, reason);
    });
  }

  async recordRuntimeFailure(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly reason: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.mutate(input, (state, now) => {
      const current = requireActiveGoal(state);
      const reason = requiredText(input.reason, "reason");
      const failureCount = current.failureCount + 1;
      const exhausted = failureCount >= 3;
      const goal = checkedGoal({
        ...current,
        status: exhausted ? "blocked" : "active",
        failureCount,
        nextRetryAt: exhausted
          ? undefined
          : now + Math.min(250 * 2 ** Math.max(0, failureCount - 1), 4_000),
        blockedReason: exhausted ? reason : undefined,
        updatedAt: now,
      });
      return change(goal, exhausted ? "blocked" : "runtime_failed", now, reason);
    });
  }

  async requestReview(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly requestedBy: "engineer" | "evaluator";
    readonly reason: string;
    readonly reviewContract: DelegationContract;
    readonly reviewContractHash: string;
    readonly userInputCursor: number;
    readonly sourceMutationEpoch: number;
    readonly sourceFingerprint: string;
  }): Promise<SessionGoal> {
    if (input.requestedBy === "engineer") requireAuthority(input.authority, "agent");
    else requireAuthority(input.authority, "runtime");
    return await this.mutate(input, (state, now) => {
      const current = requireActiveGoal(state);
      if (current.review !== undefined) return unchanged(current);
      if (current.userInputCursor !== input.userInputCursor || current.sourceMutationEpoch !== input.sourceMutationEpoch) {
        throw new SessionGoalServiceError("REVIEW_BASIS_MISMATCH", "Review basis no longer matches the Session");
      }
      if (hashDelegationContract(input.reviewContract) !== input.reviewContractHash) {
        throw new SessionGoalServiceError("REVIEW_BASIS_MISMATCH", "Review contract hash does not match the contract");
      }
      const claim = {
        claimId: crypto.randomUUID(),
        instanceId: current.instanceId,
        generation: current.generation,
        objective: current.objective,
        requestedBy: input.requestedBy,
        reason: requiredText(input.reason, "reason"),
        reviewContract: input.reviewContract,
        reviewContractHash: input.reviewContractHash,
        userInputCursor: input.userInputCursor,
        sourceMutationEpoch: input.sourceMutationEpoch,
        sourceFingerprint: input.sourceFingerprint,
        createdAt: now,
      } as const;
      const goal = checkedGoal({ ...current, review: { phase: "requested", claim, attempt: 1 }, updatedAt: now });
      return change(goal, "review_requested", now, claim.reason);
    });
  }

  async markReviewRunning(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
    readonly reviewerSessionId: string;
    readonly reviewerExecutionId: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.reviewTransition(input, "requested", (goal, now) => change(checkedGoal({
      ...goal,
      review: {
        ...goal.review!,
        phase: "review_running",
        reviewerSessionId: requiredText(input.reviewerSessionId, "reviewerSessionId"),
        reviewerExecutionId: requiredText(input.reviewerExecutionId, "reviewerExecutionId"),
      },
      updatedAt: now,
    }), "review_started", now));
  }

  async restartReview(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
    readonly reviewerSessionId: string;
    readonly reviewerExecutionId: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.reviewTransition(input, "review_running", (goal, now) => change(checkedGoal({
      ...goal,
      review: {
        phase: "review_running",
        claim: goal.review!.claim,
        attempt: goal.review!.attempt + 1,
        reviewerSessionId: requiredText(input.reviewerSessionId, "reviewerSessionId"),
        reviewerExecutionId: requiredText(input.reviewerExecutionId, "reviewerExecutionId"),
      },
      updatedAt: now,
    }), "review_restarted", now));
  }

  /** Rebinds the same attempt when a durable HITL tool batch resumes in a new Execution. */
  async continueReviewAttempt(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
    readonly reviewerSessionId: string;
    readonly reviewerExecutionId: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.reviewTransition(input, "review_running", (goal, now) => change(checkedGoal({
      ...goal,
      review: {
        ...goal.review!,
        reviewerSessionId: requiredText(input.reviewerSessionId, "reviewerSessionId"),
        reviewerExecutionId: requiredText(input.reviewerExecutionId, "reviewerExecutionId"),
      },
      updatedAt: now,
    }), "review_started", now));
  }

  async rejectReview(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
    readonly receipt: SessionGoalReviewReceipt;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.reviewTransition(input, "review_running", (goal, now) => {
      if (input.receipt.verdict !== "rejected") throw new SessionGoalServiceError("INVALID_TRANSITION", "Expected rejected receipt");
      assertCurrentReviewReceipt(goal, input.receipt);
      const receipt = input.receipt;
      return change(checkedGoal({
        ...goal,
        review: {
          phase: "remediation_required",
          claim: goal.review!.claim,
          attempt: goal.review!.attempt,
          receipt,
          remediationReason: receipt.summary,
        },
        lastReviewReceipt: receipt,
        updatedAt: now,
      }), "review_rejected", now, receipt.summary);
    });
  }

  async markRemediationRunning(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
    readonly executionId: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.reviewTransition(input, "remediation_required", (goal, now) => change(checkedGoal({
      ...goal,
      review: { ...goal.review!, phase: "remediation_running", remediationExecutionId: requiredText(input.executionId, "executionId") },
      updatedAt: now,
    }), "remediation_started", now));
  }

  /** Rebinds one still-active remediation Tool Batch to its new continuation Execution. */
  async continueRemediationExecution(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
    readonly previousExecutionId: string;
    readonly executionId: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.reviewTransition(input, "remediation_running", (goal, now) => {
      if (goal.review!.remediationExecutionId !== input.previousExecutionId) {
        throw new SessionGoalServiceError("REVIEW_BASIS_MISMATCH", "Remediation Execution does not match");
      }
      return change(checkedGoal({
        ...goal,
        review: {
          ...goal.review!,
          remediationExecutionId: requiredText(input.executionId, "executionId"),
        },
        updatedAt: now,
      }), "remediation_rebound", now);
    });
  }

  /**
   * Converts a failed/orphaned remediation Execution back into its durable
   * restart phase. A model failure already recorded by recordUsage owns its
   * existing backoff; interruption/cancellation/orphaned HITL records one here.
   */
  async requestRemediationRetry(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
    readonly executionId: string;
    readonly reason: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.reviewTransition(input, "remediation_running", (goal, now) => {
      if (goal.review!.remediationExecutionId !== input.executionId) {
        throw new SessionGoalServiceError("REVIEW_BASIS_MISMATCH", "Remediation Execution does not match");
      }
      const reason = requiredText(input.reason, "reason");
      const failureAlreadyRecorded = goal.nextRetryAt !== undefined;
      const failureCount = failureAlreadyRecorded ? goal.failureCount : goal.failureCount + 1;
      const exhausted = failureCount >= 3;
      const nextRetryAt = exhausted
        ? undefined
        : failureAlreadyRecorded
          ? goal.nextRetryAt
          : now + Math.min(250 * 2 ** Math.max(0, failureCount - 1), 4_000);
      const review = goal.review!;
      const updated = checkedGoal({
        ...goal,
        status: exhausted ? "blocked" : goal.status,
        failureCount,
        nextRetryAt,
        blockedReason: exhausted ? reason : goal.blockedReason,
        review: {
          phase: "remediation_required",
          claim: review.claim,
          attempt: review.attempt,
          receipt: review.receipt,
          remediationReason: review.remediationReason,
        },
        updatedAt: now,
      });
      return change(
        updated,
        exhausted ? "blocked" : "remediation_retry_requested",
        now,
        reason,
      );
    });
  }

  async finishRemediation(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
    readonly executionId: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.reviewTransition(input, "remediation_running", (goal, now) => {
      if (goal.review!.remediationExecutionId !== input.executionId) {
        throw new SessionGoalServiceError("REVIEW_BASIS_MISMATCH", "Remediation Execution does not match");
      }
      return change(checkedGoal({ ...goal, review: undefined, updatedAt: now }), "remediation_finished", now);
    });
  }

  async completeReview(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
    readonly receipt: SessionGoalReviewReceipt;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.reviewTransition(input, "review_running", (goal, now) => {
      if (input.receipt.verdict !== "accepted") throw new SessionGoalServiceError("INVALID_TRANSITION", "Expected accepted receipt");
      assertCurrentReviewReceipt(goal, input.receipt);
      const receipt = input.receipt;
      return change(checkedGoal({
        ...goal,
        status: "complete",
        review: undefined,
        lastReviewReceipt: receipt,
        completedAt: now,
        updatedAt: now,
      }), "completed", now, receipt.summary);
    });
  }

  async advanceUserInputCursor(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<SessionGoal | undefined> {
    requireAuthority(input.authority, "runtime");
    return await this.mutateOptional(input, (goal, now) => goal.status === "complete" ? goal : checkedGoal({
      ...goal,
      userInputCursor: goal.userInputCursor + 1,
      review: undefined,
      updatedAt: now,
    }));
  }

  async recordSourceMutation(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<SessionGoal | undefined> {
    requireAuthority(input.authority, "runtime");
    return await this.mutateOptional(input, (goal, now) => goal.status === "complete" ? goal : checkedGoal({
      ...goal,
      sourceMutationEpoch: goal.sourceMutationEpoch + 1,
      review: undefined,
      updatedAt: now,
    }));
  }

  /**
   * A watcher can observe a final filesystem event while its review is being
   * cleaned up. Bind the mutation to the exact claim so it cannot invalidate a
   * later Goal revision or review attempt.
   */
  async recordReviewSourceMutation(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly claimId: string;
  }): Promise<SessionGoal | undefined> {
    requireAuthority(input.authority, "runtime");
    return await this.sessions.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootEngineer(state);
      const goal = state.goal;
      if (goal === undefined || goal.review?.claim.claimId !== input.claimId || goal.review.phase !== "review_running") {
        return { result: undefined };
      }
      const updated = checkedGoal({
        ...goal,
        sourceMutationEpoch: goal.sourceMutationEpoch + 1,
        review: undefined,
        updatedAt: Date.now(),
      });
      return { result: updated, patch: { goal: updated } };
    });
  }

  private async reviewTransition(
    input: SessionGoalTarget & { readonly claimId: string },
    phase: SessionGoal["review"] extends infer _ ? "requested" | "review_running" | "remediation_required" | "remediation_running" : never,
    transition: (goal: SessionGoal, now: number) => MutationResult,
  ): Promise<SessionGoal> {
    return await this.mutate(input, (state, now) => {
      const goal = nonTerminalGoal(state);
      if (goal.review?.claim.claimId !== input.claimId || goal.review.phase !== phase) {
        throw new SessionGoalServiceError("INVALID_TRANSITION", `Expected review phase ${phase}`);
      }
      return transition(goal, now);
    });
  }

  private async mutate(
    target: SessionGoalTarget,
    operation: (state: Readonly<SessionStoreState>, now: number) => MutationResult,
  ): Promise<SessionGoal> {
    return await this.sessions.commitDurableSessionMutation(target.sessionId, target.workspaceRoot, (state) => {
      assertRootEngineer(state);
      const outcome = operation(state, Date.now());
      return { result: outcome.goal, patch: { goal: outcome.goal }, events: outcome.events };
    });
  }

  private async mutateOptional(
    target: SessionGoalTarget,
    operation: (goal: SessionGoal, now: number) => SessionGoal,
  ): Promise<SessionGoal | undefined> {
    return await this.sessions.commitDurableSessionMutation(target.sessionId, target.workspaceRoot, (state) => {
      assertRootEngineer(state);
      if (state.goal === undefined) return { result: undefined };
      const goal = operation(state.goal, Date.now());
      return { result: goal, patch: { goal } };
    });
  }
}

interface MutationResult {
  readonly goal: SessionGoal;
  readonly events?: readonly SessionGoalChangedEvent[];
}

function change(goal: SessionGoal, action: SessionGoalChangedEvent["action"], now: number, reason?: string): MutationResult {
  return { goal, events: [eventFor(goal, action, now, reason)] };
}

function unchanged(goal: SessionGoal): MutationResult {
  return { goal };
}

function eventFor(goal: SessionGoal, action: SessionGoalChangedEvent["action"], occurredAt: number, reason?: string): SessionGoalChangedEvent {
  return {
    type: "session.goal_changed",
    action,
    instanceId: goal.instanceId,
    generation: goal.generation,
    goal: action === "cleared" ? null : goal,
    status: goal.status,
    ...(reason === undefined ? {} : { reason }),
    occurredAt,
  };
}

function checkedGoal(value: unknown): SessionGoal {
  return SessionGoalSchema.parse(value);
}

function assertRootEngineer(state: Readonly<SessionStoreState>): void {
  if (state.parentSessionId !== undefined || state.rootSessionId !== state.sessionId || state.agentName !== "engineer") {
    throw new SessionGoalServiceError("NOT_ROOT_ENGINEER", "Session Goals belong only to root Engineer Sessions");
  }
}

function requiredGoal(state: Readonly<SessionStoreState>): SessionGoal {
  if (state.goal === undefined) throw new SessionGoalServiceError("GOAL_NOT_FOUND", "Session has no Goal");
  return state.goal;
}

function nonTerminalGoal(state: Readonly<SessionStoreState>): SessionGoal {
  const goal = requiredGoal(state);
  if (goal.status === "complete") throw new SessionGoalServiceError("GOAL_TERMINAL", "Completed Goal is immutable");
  return goal;
}

function activeGoal(state: Readonly<SessionStoreState>, expectedGeneration: number): SessionGoal {
  const goal = nonTerminalGoal(state);
  if (goal.generation !== expectedGeneration) {
    throw new SessionGoalServiceError("GENERATION_CONFLICT", `Expected generation ${expectedGeneration}, found ${goal.generation}`);
  }
  return goal;
}

function requireActiveGoal(state: Readonly<SessionStoreState>): SessionGoal {
  const goal = nonTerminalGoal(state);
  if (goal.status !== "active") throw new SessionGoalServiceError("INVALID_TRANSITION", `Goal is ${goal.status}, not active`);
  return goal;
}

function requireAuthority(authority: SessionGoalAuthority, expected: SessionGoalAuthority["kind"]): void {
  if (authority.kind !== expected) throw new SessionGoalServiceError("AUTHORITY_DENIED", `${expected} authority required`);
}

function assertCurrentReviewReceipt(goal: SessionGoal, receipt: SessionGoalReviewReceipt): void {
  const review = goal.review;
  if (review === undefined
    || receipt.claimId !== review.claim.claimId
    || receipt.attempt !== review.attempt
    || receipt.reviewerSessionId !== review.reviewerSessionId
    || receipt.reviewerExecutionId !== review.reviewerExecutionId) {
    throw new SessionGoalServiceError("REVIEW_BASIS_MISMATCH", "Review receipt does not match the active Reviewer attempt");
  }
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new SessionGoalServiceError("INVALID_TRANSITION", `${field} must not be empty`);
  return trimmed;
}

function positiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new SessionGoalServiceError("INVALID_TRANSITION", `${field} must be a positive safe integer`);
  return value;
}

function nonNegativeInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SessionGoalServiceError("INVALID_TRANSITION", `${field} must be a non-negative safe integer`);
  return value;
}
