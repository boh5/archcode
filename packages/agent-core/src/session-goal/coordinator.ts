import { addUsage, createEmptySessionStats, type DelegationContract, type NormalizedUsage, type SessionGoal } from "@archcode/protocol";
import type { SessionExecutionManager } from "../execution/session-execution-manager";
import { AgentRunningError } from "../agents/errors";
import type { Logger } from "../logger";
import type { ModelRuntime } from "../models";
import type { ModelSelectionResolver } from "../models/model-selection-resolver";
import { SessionFileNotFoundError } from "../store/errors";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import { scopedKey } from "../store/key";
import { SessionGoalService, SessionGoalServiceError } from "./service";
import { SessionGoalEvaluator } from "./evaluator";
import {
  GoalReviewGate,
  collectGoalReviewerToolEvidence,
  toSessionGoalReviewReceipt,
} from "./review-gate";
import { SessionGoalReviewSourceMonitor } from "./review-source-monitor";

export interface SessionGoalCoordinatorInput {
  readonly workspaceRoot: string;
  readonly projectSlug: string;
  readonly rootSessionId: string;
}

/**
 * Single high-cohesion owner of the Goal idle transition. The ordinary Session
 * manager remains the only execution admission owner; this class only decides
 * which persisted Goal next-action may request that owner next.
 */
export class SessionGoalCoordinator {
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #reviewMonitors = new Map<string, SessionGoalReviewSourceMonitor>();
  readonly #evaluator: SessionGoalEvaluator;
  readonly #reviewGate = new GoalReviewGate();

  constructor(private readonly dependencies: {
    readonly service: SessionGoalService;
    readonly storeManager: SessionStoreManager;
    readonly executionManager: SessionExecutionManager;
    readonly modelRuntime: ModelRuntime;
    readonly modelSelectionResolver: ModelSelectionResolver;
    readonly logger: Logger;
  }) {
    this.#evaluator = new SessionGoalEvaluator(dependencies.logger.child({ module: "session-goal.evaluator" }));
  }

  get activeReviewMonitorCount(): number {
    return this.#reviewMonitors.size;
  }

  reconcile(input: SessionGoalCoordinatorInput): Promise<void> {
    const key = scopedKey(input.workspaceRoot, input.rootSessionId);
    const current = this.#inFlight.get(key);
    if (current !== undefined) return current;
    let retryAt: number | undefined;
    const operation = this.#reconcile(input)
      .catch(async (error) => {
        if (!isBenignGoalReconcileError(error)) {
          this.dependencies.logger.warn("session-goal.runtime.failed", {
            error,
            context: { sessionId: input.rootSessionId },
          });
          try {
            const failed = await this.dependencies.service.recordRuntimeFailure({
              workspaceRoot: input.workspaceRoot,
              sessionId: input.rootSessionId,
              authority: { kind: "runtime" },
              reason: runtimeFailureReason(error),
            });
            if (failed.status === "active") retryAt = failed.nextRetryAt;
          } catch (recordError) {
            this.dependencies.logger.warn("session-goal.runtime-failure.record.failed", {
              error: recordError,
              context: { sessionId: input.rootSessionId },
            });
          }
        }
        throw error;
      })
      .finally(() => {
        if (this.#inFlight.get(key) === operation) this.#inFlight.delete(key);
        // The replay must be registered only after this operation leaves the
        // in-flight gate. Otherwise a zero-delay retry can join the same
        // rejected Promise and permanently strand the persisted next-action.
        if (retryAt !== undefined) this.#scheduleRetry(input, retryAt);
      });
    this.#inFlight.set(key, operation);
    return operation;
  }

  async reconcileAll(workspaceRoot: string, projectSlug: string): Promise<void> {
    const summaries = await this.dependencies.storeManager.listAllSessionSummaries(workspaceRoot);
    await Promise.all(summaries
      .filter((summary) => summary.sessionId === summary.rootSessionId && summary.agentName === "engineer")
      .map((summary) => this.reconcile({ workspaceRoot, projectSlug, rootSessionId: summary.sessionId })));
  }

  async dispose(): Promise<void> {
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    const monitors = [...this.#reviewMonitors.values()];
    this.#reviewMonitors.clear();
    await Promise.all(monitors.map((monitor) => monitor.dispose()));
  }

  async disposeWorkspace(workspaceRoot: string): Promise<void> {
    for (const [key, timer] of this.#retryTimers) {
      if (!key.startsWith(`${workspaceRoot}\0`)) continue;
      clearTimeout(timer);
      this.#retryTimers.delete(key);
    }
    const monitors: SessionGoalReviewSourceMonitor[] = [];
    for (const [key, monitor] of this.#reviewMonitors) {
      if (!key.startsWith(`${workspaceRoot}\0`)) continue;
      this.#reviewMonitors.delete(key);
      monitors.push(monitor);
    }
    await Promise.all(monitors.map((monitor) => monitor.dispose()));
  }

  async requestReview(input: SessionGoalCoordinatorInput & {
    readonly requestedBy: "engineer" | "evaluator";
    readonly reason: string;
  }): Promise<void> {
    const store = await this.dependencies.storeManager.getOrLoad(input.rootSessionId, input.workspaceRoot);
    const state = store.getState();
    const goal = state.goal;
    if (goal === undefined || goal.status !== "active" || goal.review !== undefined) return;
    const basis = await this.#reviewGate.createBasis(state.cwd, goal);
    await this.dependencies.service.requestReview({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.rootSessionId,
      authority: { kind: input.requestedBy === "engineer" ? "agent" : "runtime" },
      requestedBy: input.requestedBy,
      reason: input.reason,
      reviewContract: basis.contract,
      reviewContractHash: basis.contractHash,
      userInputCursor: goal.userInputCursor,
      sourceMutationEpoch: goal.sourceMutationEpoch,
      sourceFingerprint: basis.sourceFingerprint,
    });
  }

  async ensureReviewMonitor(input: SessionGoalCoordinatorInput & {
    readonly claimId: string;
    readonly reviewerSessionId: string;
    readonly reviewerExecutionId: string;
  }): Promise<boolean> {
    const goal = await this.dependencies.service.get({ workspaceRoot: input.workspaceRoot, sessionId: input.rootSessionId });
    const review = goal?.review;
    if (
      review?.phase !== "review_running"
      || review.claim.claimId !== input.claimId
      || review.reviewerSessionId !== input.reviewerSessionId
      || review.reviewerExecutionId !== input.reviewerExecutionId
    ) return false;
    return await this.#startReviewMonitor(input, review.claim.claimId, review.attempt);
  }

  async #reconcile(input: SessionGoalCoordinatorInput): Promise<void> {
    if (this.dependencies.executionManager.getSessionFamilyActivity(input.workspaceRoot, input.rootSessionId) !== "idle") return;
    if ((await this.dependencies.executionManager.listSessionFamilyToolBatchHitlIds(input.workspaceRoot, input.rootSessionId)).length > 0) return;

    // Canonical queued user input always outranks an autonomous Goal action.
    const queued = await this.dependencies.executionManager.tryStartQueuedExecution({
      slug: input.projectSlug,
      workspaceRoot: input.workspaceRoot,
      sessionId: input.rootSessionId,
    });
    if (queued !== undefined) return;

    const store = await this.dependencies.storeManager.getOrLoad(input.rootSessionId, input.workspaceRoot);
    const state = store.getState();
    const goal = state.goal;
    if (goal === undefined || goal.status !== "active") {
      await this.#stopRootReviewMonitors(input);
      return;
    }
    if (goal.tokenBudget !== undefined && goal.usage.tokens.totalTokens >= goal.tokenBudget) return;
    if (goal.nextRetryAt !== undefined && goal.nextRetryAt > Date.now()) {
      this.#scheduleRetry(input, goal.nextRetryAt);
      return;
    }

    if (goal.review?.phase === "requested") {
      await this.#startRequestedReview(input, goal);
      return;
    }
    if (goal.review?.phase === "review_running") {
      await this.#settleOrRecoverReview(input, goal);
      return;
    }
    if (goal.review?.phase === "remediation_required") {
      await this.#startRemediation(input, goal);
      return;
    }
    if (goal.review?.phase === "remediation_running") {
      const executionId = goal.review.remediationExecutionId;
      if (executionId === undefined) throw new Error("remediation_running Goal has no Execution id");
      const execution = state.executions.find((candidate) => candidate.id === executionId);
      if (execution === undefined) {
        const activeBatch = state.toolBatches.find((batch) => batch.archivedAt === undefined);
        if (activeBatch !== undefined) {
          await this.dependencies.executionManager.startSessionToolBatchExecution({
            slug: input.projectSlug,
            workspaceRoot: input.workspaceRoot,
            sessionId: input.rootSessionId,
          });
        } else {
          await this.#launchRootContinuation(input, "goal_remediation", goal.review.remediationReason ?? "Address review findings", executionId);
        }
        return;
      }
      if (execution.status === "running") return;
      if (execution.status === "completed") {
        await this.dependencies.service.finishRemediation({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.rootSessionId,
          authority: { kind: "runtime" },
          claimId: goal.review.claim.claimId,
          executionId,
        });
        await this.#evaluateAndContinue(input);
        return;
      }
      const retry = await this.dependencies.service.requestRemediationRetry({
        workspaceRoot: input.workspaceRoot,
        sessionId: input.rootSessionId,
        authority: { kind: "runtime" },
        claimId: goal.review.claim.claimId,
        executionId,
        reason: `Remediation Execution ended as ${execution.status}`,
      });
      if (retry.status !== "active") return;
      if (retry.nextRetryAt !== undefined && retry.nextRetryAt > Date.now()) {
        this.#scheduleRetry(input, retry.nextRetryAt);
        return;
      }
      await this.#startRemediation(input, retry);
      return;
    }

    if (goal.review === undefined) await this.#stopRootReviewMonitors(input);
    await this.#evaluateAndContinue(input);
  }

  #scheduleRetry(input: SessionGoalCoordinatorInput, retryAt: number): void {
    const key = scopedKey(input.workspaceRoot, input.rootSessionId);
    if (this.#retryTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.#retryTimers.delete(key);
      void this.reconcile(input).catch((error) => {
        this.dependencies.logger.warn("session-goal.retry.failed", {
          error,
          context: { sessionId: input.rootSessionId },
        });
      });
    }, Math.max(0, retryAt - Date.now()));
    timer.unref?.();
    this.#retryTimers.set(key, timer);
  }

  async #evaluateAndContinue(input: SessionGoalCoordinatorInput): Promise<void> {
    const store = await this.dependencies.storeManager.getOrLoad(input.rootSessionId, input.workspaceRoot);
    const state = store.getState();
    const goal = state.goal;
    if (goal === undefined || goal.status !== "active" || goal.review !== undefined) return;
    const engineerDefault = this.dependencies.modelRuntime.current.getAgentDefault("engineer");
    if (engineerDefault === undefined) throw new Error("Engineer model binding is unavailable for Goal evaluator admission");
    const command = await this.dependencies.executionManager.runSessionCommand({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.rootSessionId,
      clientRequestId: `goal-evaluator:${goal.instanceId}:${goal.generation}:${goal.evaluatorCount + 1}`,
      requestedModelSelection: { mode: "agent_default", selection: engineerDefault },
    }, async (_commandBinding, signal) => {
      const admittedState = (await this.dependencies.storeManager.getOrLoad(
        input.rootSessionId,
        input.workspaceRoot,
      )).getState();
      const admittedGoal = admittedState.goal;
      if (admittedGoal === undefined || admittedGoal.status !== "active" || admittedGoal.review !== undefined) {
        return { action: "none" as const };
      }
      const binding = this.dependencies.modelSelectionResolver.resolve({
        snapshot: this.dependencies.modelRuntime.current,
        agentName: "reviewer",
        sessionOverride: admittedState.modelSelection.override,
      });
      const evaluatorStartedAt = Date.now();
      let evaluatorUsage: NormalizedUsage = createEmptySessionStats().usage;
      const evaluation = await this.#evaluator.evaluate({
        binding,
        state: admittedState,
        objective: admittedGoal.objective,
        abortSignal: signal,
        onUsage: (usage) => { evaluatorUsage = addUsage(evaluatorUsage, usage); },
      });
      const afterEvaluatorUsage = await this.dependencies.service.recordUsage({
        workspaceRoot: input.workspaceRoot,
        sessionId: input.rootSessionId,
        authority: { kind: "runtime" },
        usage: evaluatorUsage,
        executionTimeMs: Math.max(0, Date.now() - evaluatorStartedAt),
      });
      if (afterEvaluatorUsage.status !== "active") return { action: "none" as const };
      const updated = await this.dependencies.service.recordEvaluatorDecision({
        workspaceRoot: input.workspaceRoot,
        sessionId: input.rootSessionId,
        authority: { kind: "runtime" },
        decision: evaluation.decision,
        reason: evaluation.reason,
        madeProgress: evaluation.madeProgress,
      });
      if (updated.noProgressCount >= 3) {
        await this.dependencies.service.blockForNoProgress({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.rootSessionId,
          authority: { kind: "runtime" },
          reason: evaluation.reason,
        });
        return { action: "blocked" as const };
      }
      if (evaluation.decision === "candidate_complete") {
        await this.requestReview({ ...input, requestedBy: "evaluator", reason: evaluation.reason });
        return { action: "review" as const };
      }
      return { action: "continue" as const, reason: evaluation.reason };
    });
    if (command.kind !== "executed" || command.result.action === "none" || command.result.action === "blocked") return;

    const queued = await this.dependencies.executionManager.tryStartQueuedExecution({
      slug: input.projectSlug,
      workspaceRoot: input.workspaceRoot,
      sessionId: input.rootSessionId,
    });
    if (queued !== undefined) return;
    if (command.result.action === "review") {
      const requested = (await this.dependencies.storeManager.getOrLoad(
        input.rootSessionId,
        input.workspaceRoot,
      )).getState().goal;
      if (requested?.review?.phase === "requested") await this.#startRequestedReview(input, requested);
      return;
    }
    await this.#launchRootContinuation(input, "goal_continuation", command.result.reason);
  }

  async #startRequestedReview(input: SessionGoalCoordinatorInput, goal: SessionGoal): Promise<void> {
    const review = goal.review;
    if (review?.phase !== "requested") return;
    const reviewerSessionId = crypto.randomUUID();
    const reviewerExecutionId = crypto.randomUUID();
    await this.dependencies.service.markReviewRunning({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.rootSessionId,
      authority: { kind: "runtime" },
      claimId: review.claim.claimId,
      reviewerSessionId,
      reviewerExecutionId,
    });
    await this.#launchReviewChild(input, review.claim.reviewContract, review.claim.claimId, review.attempt, reviewerSessionId, reviewerExecutionId);
  }

  async #settleOrRecoverReview(input: SessionGoalCoordinatorInput, goal: SessionGoal): Promise<void> {
    const review = goal.review;
    if (review?.phase !== "review_running") return;
    // Reconcile is also the server-restart recovery path. Reacquire the
    // attempt-owned monitor before inspecting a still-running reviewer, so a
    // reviewer cannot continue after process-local watch state disappeared.
    if (!await this.#startReviewMonitor(input, review.claim.claimId, review.attempt)) {
      throw new SessionGoalReviewMonitorInvalidatedError("review_monitor_recovery_unavailable");
    }
    const reviewerSessionId = review.reviewerSessionId!;
    const reviewerExecutionId = review.reviewerExecutionId!;
    let childState: SessionStoreState | undefined;
    try {
      childState = (await this.dependencies.storeManager.getOrLoad(reviewerSessionId, input.workspaceRoot)).getState();
    } catch (error) {
      if (!(error instanceof SessionFileNotFoundError)) throw error;
    }
    if (childState === undefined) {
      await this.#stopReviewMonitor(input, review.claim.claimId, review.attempt);
      await this.#restartReview(input, goal);
      return;
    }
    const execution = childState.executions.find((candidate) => candidate.id === reviewerExecutionId);
    if (execution === undefined || (execution.status !== "running" && execution.status !== "completed")) {
      await this.#stopReviewMonitor(input, review.claim.claimId, review.attempt);
      await this.#restartReview(input, goal);
      return;
    }
    if (execution.status === "running") return;

    // The completion transition and an incoming user-input mutation share one
    // SessionExecutionManager-owned linearization point. A persisted/queued
    // user message therefore wins over autonomous completion, while a
    // completion that won first is fully settled before that later input runs.
    const settled = await this.dependencies.executionManager.tryRunSessionFamilyControl(input, async () => {
      const latest = await this.dependencies.service.get({ workspaceRoot: input.workspaceRoot, sessionId: input.rootSessionId });
      if (
        latest?.review?.phase !== "review_running"
        || latest.review.claim.claimId !== review.claim.claimId
        || latest.review.reviewerExecutionId !== reviewerExecutionId
      ) return { kind: "stale" as const };

      await this.#stopReviewMonitor(input, review.claim.claimId, review.attempt);
      const resultReceipt = childState.childResultReceipts.find((receipt) => receipt.executionId === reviewerExecutionId);
      const decision = await this.#reviewGate.decide({
        cwd: (await this.dependencies.storeManager.getOrLoad(input.rootSessionId, input.workspaceRoot)).getState().cwd,
        goal: latest,
        reviewerSessionId,
        reviewerExecutionId,
        resultReceipt,
        reviewerToolEvidence: collectGoalReviewerToolEvidence(childState),
      });
      const receipt = toSessionGoalReviewReceipt({
        claimId: review.claim.claimId,
        attempt: review.attempt,
        reviewerSessionId,
        reviewerExecutionId,
        decision,
      });
      if (decision.verdict === "accepted") {
        await this.dependencies.service.completeReview({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.rootSessionId,
          authority: { kind: "runtime" },
          claimId: review.claim.claimId,
          receipt,
        });
        return { kind: "accepted" as const };
      }
      await this.dependencies.service.rejectReview({
        workspaceRoot: input.workspaceRoot,
        sessionId: input.rootSessionId,
        authority: { kind: "runtime" },
        claimId: review.claim.claimId,
        receipt,
      });
      return { kind: "rejected" as const };
    });
    if (settled.kind !== "executed" || settled.result.kind !== "rejected") return;
    const remediating = (await this.dependencies.storeManager.getOrLoad(
      input.rootSessionId,
      input.workspaceRoot,
    )).getState().goal;
    if (remediating?.review?.phase === "remediation_required") {
      await this.#startRemediation(input, remediating);
    }
  }

  async #restartReview(input: SessionGoalCoordinatorInput, goal: SessionGoal): Promise<void> {
    const review = goal.review;
    if (review?.phase !== "review_running") return;
    const reviewerSessionId = crypto.randomUUID();
    const reviewerExecutionId = crypto.randomUUID();
    await this.#stopReviewMonitor(input, review.claim.claimId, review.attempt);
    await this.dependencies.service.restartReview({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.rootSessionId,
      authority: { kind: "runtime" },
      claimId: review.claim.claimId,
      reviewerSessionId,
      reviewerExecutionId,
    });
    await this.#launchReviewChild(input, review.claim.reviewContract, review.claim.claimId, review.attempt + 1, reviewerSessionId, reviewerExecutionId);
  }

  async #launchReviewChild(
    input: SessionGoalCoordinatorInput,
    contract: DelegationContract,
    claimId: string,
    attempt: number,
    reviewerSessionId: string,
    reviewerExecutionId: string,
  ): Promise<void> {
    const parentStore = await this.dependencies.storeManager.getOrLoad(input.rootSessionId, input.workspaceRoot);
    if (!await this.#startReviewMonitor(input, claimId, attempt)) {
      throw new SessionGoalReviewMonitorInvalidatedError("prelaunch_monitor_unavailable");
    }
    try {
      await this.dependencies.executionManager.startRuntimeReviewChild(input.workspaceRoot, {
        provenance: { kind: "goal_review", reviewClaimId: claimId },
        parentStore,
        parentSessionId: input.rootSessionId,
        reviewerSessionId,
        reviewerExecutionId,
        contract,
      });
    } catch (error) {
      await this.#stopReviewMonitor(input, claimId, attempt);
      throw error;
    }
  }

  async #startReviewMonitor(
    input: SessionGoalCoordinatorInput,
    claimId: string,
    attempt: number,
  ): Promise<boolean> {
    const key = this.#reviewMonitorKey(input, claimId, attempt);
    if (this.#reviewMonitors.has(key)) return true;
    const parentStore = await this.dependencies.storeManager.getOrLoad(input.rootSessionId, input.workspaceRoot);
    const monitor = await SessionGoalReviewSourceMonitor.start({
      cwd: parentStore.getState().cwd,
      logger: this.dependencies.logger,
      onSourceMutation: async () => {
        await this.dependencies.service.recordReviewSourceMutation({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.rootSessionId,
          authority: { kind: "runtime" },
          claimId,
        });
        // Clearing the claim bypasses normal review settlement, so release
        // this short-lived monitor from the invalidation path itself.
        void this.#stopReviewMonitor(input, claimId, attempt).catch((error) => {
          this.dependencies.logger.warn("session-goal.review-source-monitor.dispose_failed", {
            error,
            context: { sessionId: input.rootSessionId, claimId, attempt },
          });
        });
      },
    });
    if (monitor.invalidationReason !== undefined) {
      await monitor.dispose();
      return false;
    }
    this.#reviewMonitors.set(key, monitor);
    return true;
  }

  async #stopReviewMonitor(input: SessionGoalCoordinatorInput, claimId: string, attempt: number): Promise<void> {
    const key = this.#reviewMonitorKey(input, claimId, attempt);
    const monitor = this.#reviewMonitors.get(key);
    if (monitor === undefined) return;
    this.#reviewMonitors.delete(key);
    await monitor.dispose();
  }

  async #stopRootReviewMonitors(input: SessionGoalCoordinatorInput): Promise<void> {
    const prefix = scopedKey(input.workspaceRoot, input.rootSessionId + "\0");
    const monitors: SessionGoalReviewSourceMonitor[] = [];
    for (const [key, monitor] of this.#reviewMonitors) {
      if (!key.startsWith(prefix)) continue;
      this.#reviewMonitors.delete(key);
      monitors.push(monitor);
    }
    await Promise.all(monitors.map((monitor) => monitor.dispose()));
  }

  #reviewMonitorKey(input: SessionGoalCoordinatorInput, claimId: string, attempt: number): string {
    return scopedKey(input.workspaceRoot, input.rootSessionId + "\0" + claimId + "\0" + attempt);
  }

  async #startRemediation(input: SessionGoalCoordinatorInput, goal: SessionGoal): Promise<void> {
    const review = goal.review;
    if (review?.phase !== "remediation_required") return;
    const executionId = crypto.randomUUID();
    await this.dependencies.service.markRemediationRunning({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.rootSessionId,
      authority: { kind: "runtime" },
      claimId: review.claim.claimId,
      executionId,
    });
    await this.#launchRootContinuation(input, "goal_remediation", review.remediationReason ?? "Address review findings", executionId);
  }

  async #launchRootContinuation(
    input: SessionGoalCoordinatorInput,
    origin: "goal_continuation" | "goal_remediation",
    reason: string,
    executionId?: string,
  ): Promise<void> {
    const store = await this.dependencies.storeManager.getOrLoad(input.rootSessionId, input.workspaceRoot);
    store.getState().append({
      type: "system-notice",
      message: origin === "goal_remediation"
        ? `Independent review rejected completion. Continue the same Goal and remediate: ${reason}`
        : `Continue pursuing the active Goal. Evaluator reason: ${reason}`,
    });
    await this.dependencies.storeManager.flushSession(input.rootSessionId, input.workspaceRoot);
    try {
      await this.dependencies.executionManager.startCheckedExecution({
        slug: input.projectSlug,
        workspaceRoot: input.workspaceRoot,
        sessionId: input.rootSessionId,
        input: { kind: "continuation" },
        origin,
        ...(executionId === undefined ? {} : { executionId }),
      });
    } catch (error) {
      if (error instanceof AgentRunningError) return;
      throw error;
    }
  }
}

export function isBenignGoalReconcileError(error: unknown): boolean {
  return error instanceof SessionGoalServiceError
    && (error.code === "REVIEW_BASIS_MISMATCH" || error.code === "INVALID_TRANSITION");
}

class SessionGoalReviewMonitorInvalidatedError extends Error {
  constructor(reason: string) {
    super("Goal review source monitor invalidated the claim before Reviewer launch: " + reason);
    this.name = "SessionGoalReviewMonitorInvalidatedError";
  }
}

function runtimeFailureReason(_error: unknown): string {
  // Runtime errors can contain provider payloads or absolute host paths. Keep
  // the persisted/UI-visible blocker stable and leave details in the redacted
  // server log.
  return "Goal runtime orchestration failed";
}
