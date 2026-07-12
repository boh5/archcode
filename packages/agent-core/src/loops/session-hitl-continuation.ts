import type { LoopHitlCheckpoint, LoopRunReport } from "@archcode/protocol";

import type {
  SessionLoopHitlContinuationCoordinator as SessionContinuationContract,
  SessionLoopHitlContinuationLease,
} from "../execution/session-hitl-resume-adapter";
import type { ToolExecutionOrigin } from "../tools/types";
import type { GoalState } from "../goals/state";
import { collisionLeaseExpiresAtForRun, CollisionLedger } from "./collision-ledger";
import { LoopJobCoordinator } from "./coordinator";
import type { LoopJobExecutionLease, LoopJobRecord } from "./job-queue";
import { LoopJobQueue } from "./job-queue";
import { LoopStateManager } from "./state";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";

export type LoopSessionHitlContinuationConflictReason =
  | "run_id_missing"
  | "run_unexpected"
  | "session_mismatch"
  | "job_id_missing"
  | "job_unavailable"
  | "collision_conflict";

export class LoopSessionHitlContinuationConflictError extends Error {
  constructor(
    public readonly hitlId: string,
    public readonly reason: LoopSessionHitlContinuationConflictReason,
    message: string,
  ) {
    super(message);
    this.name = "LoopSessionHitlContinuationConflictError";
  }
}

export interface LoopSessionHitlContinuationCoordinatorOptions {
  readonly stateManager: LoopStateManager;
  readonly jobQueue: LoopJobQueue;
  readonly jobCoordinator: LoopJobCoordinator;
  readonly collisionLedger: CollisionLedger;
  readonly now?: () => number;
  /** Schedules the existing durable cleanup saga after the Session lease unwinds. */
  readonly scheduleCleanup: (input: { readonly loopId: string; readonly runId: string; readonly jobId: string }) => void;
  readonly readGoal?: (goalId: string) => Promise<GoalState>;
  readonly onGoalContinuationQueued?: (input: { readonly loopId: string; readonly jobId: string }) => void;
  readonly logger?: Logger;
}

/**
 * Loop-owned control-plane capability used by Session HITL replay. Session code
 * can request a lease, but only this coordinator may reclaim/finish the Loop
 * job or reacquire its collision targets.
 */
export class LoopSessionHitlContinuationCoordinator implements SessionContinuationContract {
  readonly #stateManager: LoopStateManager;
  readonly #jobQueue: LoopJobQueue;
  readonly #jobCoordinator: LoopJobCoordinator;
  readonly #collisionLedger: CollisionLedger;
  readonly #now: () => number;
  readonly #scheduleCleanup: LoopSessionHitlContinuationCoordinatorOptions["scheduleCleanup"];
  readonly #readGoal?: LoopSessionHitlContinuationCoordinatorOptions["readGoal"];
  readonly #onGoalContinuationQueued?: LoopSessionHitlContinuationCoordinatorOptions["onGoalContinuationQueued"];
  readonly #logger: Logger;

  constructor(options: LoopSessionHitlContinuationCoordinatorOptions) {
    this.#stateManager = options.stateManager;
    this.#jobQueue = options.jobQueue;
    this.#jobCoordinator = options.jobCoordinator;
    this.#collisionLedger = options.collisionLedger;
    this.#now = options.now ?? (() => Date.now());
    if (options.scheduleCleanup === undefined) {
      throw new Error("LoopSessionHitlContinuationCoordinator requires cleanup scheduling.");
    }
    this.#scheduleCleanup = options.scheduleCleanup;
    this.#readGoal = options.readGoal;
    this.#onGoalContinuationQueued = options.onGoalContinuationQueued;
    this.#logger = (options.logger ?? silentLogger).child({ module: "loops.goal-continuation" });
  }

  /** Reconciles the exact Loop run/job from already-committed Goal state. */
  async reconcileGoalState(goalId: string): Promise<void> {
    if (this.#readGoal === undefined) throw new Error("Loop Goal continuation requires Goal state access.");
    const goal = await this.#readGoal(goalId);
    if (goal.loopId === undefined || goal.mainSessionId === undefined) return;
    const loop = await this.#stateManager.read(goal.loopId);
    const goalTerminalStatus = goal.status === "done"
      ? "succeeded" as const
      : goal.status === "failed"
        ? "failed" as const
        : goal.status === "cancelled"
          ? "cancelled" as const
          : undefined;
    const currentRun = loop.currentRun?.goalId === goal.id
      && loop.currentRun.sessionId === goal.mainSessionId
      ? loop.currentRun
      : undefined;
    const reportFirstRun = currentRun === undefined
      && goalTerminalStatus !== undefined
      && loop.lastRun?.goalId === goal.id
      && loop.lastRun.sessionId === goal.mainSessionId
      && loop.lastRun.status === goalTerminalStatus
      ? loop.lastRun
      : undefined;
    const run = currentRun ?? reportFirstRun;
    if (run === undefined) return;
    if (run.jobId === undefined) return;
    const job = await this.#jobQueue.read(run.jobId);
    if (
      job.runId !== run.runId
      || job.sessionId !== goal.mainSessionId
    ) return;

    if (goalTerminalStatus !== undefined) {
      const terminalReport: LoopRunReport = reportFirstRun ?? {
        ...run,
        status: goalTerminalStatus,
        endedAt: this.#now(),
        blockedReason: undefined,
        blockedByHitlIds: undefined,
        attentionStatus: "clear",
        resumeCheckpoint: undefined,
        summary: goal.status === "done"
          ? goal.finalSummary
          : goal.status === "cancelled"
            ? "Goal cancelled."
            : goal.lastError?.message ?? "Goal failed.",
        ...(goal.status === "failed" && goal.lastError !== undefined ? { error: goal.lastError.message } : {}),
        ...(goal.status === "cancelled" ? { reason: "cancelled_by_user" as const } : {}),
      };
      if (reportFirstRun === undefined) {
        await this.#stateManager.recordRunFinish(loop.loopId, terminalReport);
      }
      const blockersToClear = new Set([...(loop.blockedByHitlIds ?? []), ...(run.blockedByHitlIds ?? [])]);
      for (const blockedHitlId of blockersToClear) {
        await this.#stateManager.clearHitlBlocker(loop.loopId, blockedHitlId);
      }
      const converged = await this.#jobCoordinator.reconcileReportedFinish(job, {
        status: goalTerminalStatus,
        summary: terminalReport.summary,
        worktreePath: terminalReport.worktreePath,
        worktreeBranchName: terminalReport.worktreeBranchName,
        baseSha: terminalReport.baseSha,
        resolvedHeadSha: terminalReport.resolvedHeadSha,
        cleanupState: terminalReport.cleanupState,
        cleanupWarning: terminalReport.cleanupWarning,
        observedArtifacts: terminalReport.observedArtifacts,
      });
      if (converged.status !== goalTerminalStatus) {
        throw new Error(`Loop job ${job.jobId} did not converge to terminal Goal run ${run.runId}.`);
      }
      await this.#collisionLedger.releaseRun(loop.loopId, run.runId);
      return;
    }

    if (goal.pendingHitlIds.length > 0) {
      const nextHitlId = goal.pendingHitlIds[0]!;
      const alreadyAdvanced = run.blockedByHitlIds !== undefined
        && sameStringSet(run.blockedByHitlIds, goal.pendingHitlIds)
        && run.resumeCheckpoint?.hitlId === nextHitlId;
      if (alreadyAdvanced) {
        await this.#convergeBlockedJobFromRun(job, run);
        return;
      }
      if (
        run.status !== "needs_user"
        || job.status !== "needs_user"
        || run.blockedByHitlIds === undefined
        || !goal.pendingHitlIds.every((pendingId) => run.blockedByHitlIds?.includes(pendingId) === true)
      ) return;
      const checkpoint = {
        ...(run.resumeCheckpoint ?? checkpointFor(nextHitlId, run, job)),
        hitlId: nextHitlId,
      };
      const advancedRun = await this.#stateManager.recordRunBlocked(loop.loopId, {
        ...run,
        blockedByHitlIds: [...goal.pendingHitlIds],
        resumeCheckpoint: checkpoint,
      });
      const authoritative = advancedRun.currentRun;
      if (authoritative?.status !== "needs_user" || authoritative.runId !== run.runId) {
        throw new LoopSessionHitlContinuationConflictError(nextHitlId, "run_unexpected", `Loop run ${run.runId} lost Goal HITL ownership while advancing blockers`);
      }
      await this.#convergeBlockedJobFromRun(job, authoritative);
      return;
    }

    const resolvedHitlId = run.blockedByHitlIds?.find((id) => goal.appliedHitlIds.includes(id));
    if (resolvedHitlId === undefined) return;
    if (job.status === "needs_user") {
      if (job.blockedByHitlIds?.includes(resolvedHitlId) !== true) return;
      await this.#jobCoordinator.requeueResolvedGoalHitl(job, resolvedHitlId);
    } else if (job.status !== "pending") {
      return;
    }
    const latest = await this.#stateManager.read(loop.loopId);
    if (latest.currentRun?.runId !== run.runId || latest.currentRun.goalId !== goal.id) return;
    await this.#stateManager.recordRunStart(loop.loopId, {
      ...run,
      status: "running",
      endedAt: undefined,
      blockedReason: undefined,
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
      resumeCheckpoint: undefined,
    });
    this.#onGoalContinuationQueued?.({ loopId: loop.loopId, jobId: job.jobId });
  }

  async acquire(input: {
    readonly origin: ToolExecutionOrigin;
    readonly sessionId: string;
    readonly rootSessionId: string;
    readonly hitlId: string;
  }): Promise<SessionLoopHitlContinuationLease> {
    const runId = input.origin.runId;
    if (runId === undefined) {
      throw new LoopSessionHitlContinuationConflictError(input.hitlId, "run_id_missing", `Loop Session HITL ${input.hitlId} has no run id`);
    }
    const state = await this.#stateManager.read(input.origin.loopId);
    const terminalRun = state.lastRun?.runId === runId
      && state.lastRun.sessionId === input.rootSessionId
      && state.lastRun.status !== "running"
      && state.lastRun.status !== "needs_user"
      ? state.lastRun
      : undefined;
    if (terminalRun !== undefined) {
      if (terminalRun.jobId === undefined) {
        throw new LoopSessionHitlContinuationConflictError(input.hitlId, "job_id_missing", `Terminal Loop run ${runId} has no durable job id`);
      }
      const expectedJobStatus = terminalJobStatusForReport(terminalRun);
      let terminalJob = await this.#jobQueue.read(terminalRun.jobId);
      if (terminalJob.status !== expectedJobStatus) {
        terminalJob = await this.#jobCoordinator.reconcileReportedFinish(terminalJob, {
          status: expectedJobStatus,
          summary: terminalRun.summary,
          blockedReason: terminalRun.blockedReason,
          blockedByHitlIds: terminalRun.blockedByHitlIds,
          attentionStatus: terminalRun.attentionStatus,
          resumeCheckpoint: terminalRun.resumeCheckpoint,
          worktreePath: terminalRun.worktreePath,
          worktreeBranchName: terminalRun.worktreeBranchName,
          baseSha: terminalRun.baseSha,
          resolvedHeadSha: terminalRun.resolvedHeadSha,
          cleanupState: terminalRun.cleanupState,
          cleanupWarning: terminalRun.cleanupWarning,
          observedArtifacts: terminalRun.observedArtifacts,
        });
      }
      if (terminalJob.status !== expectedJobStatus) {
        throw new LoopSessionHitlContinuationConflictError(input.hitlId, "job_unavailable", `Terminal Loop run ${runId} diverged from job ${terminalJob.jobId} status ${terminalJob.status}`);
      }
      return this.#alreadyCompletedLease(terminalRun, terminalJob);
    }
    let blockedRun = state.currentRun;
    let existingJob: LoopJobRecord | undefined;
    if (blockedRun?.runId === runId && blockedRun.status === "running" && blockedRun.jobId !== undefined) {
      existingJob = await this.#jobQueue.read(blockedRun.jobId);
      const recoveryCheckpoint = existingJob.resumeCheckpoint;
      if (
        existingJob.status === "needs_user"
        && existingJob.blockedByHitlIds?.includes(input.hitlId) === true
        && recoveryCheckpoint?.hitlId === input.hitlId
        && recoveryCheckpoint.intendedContinuation === "resume_run"
      ) {
        blockedRun = {
          ...blockedRun,
          status: "needs_user",
          endedAt: this.#now(),
          blockedReason: "needs_user",
          blockedByHitlIds: existingJob.blockedByHitlIds,
          attentionStatus: "waiting_for_human",
          resumeCheckpoint: recoveryCheckpoint,
          summary: "Recovered interrupted Session HITL continuation.",
        };
        await this.#stateManager.recordRunBlocked(blockedRun.loopId, blockedRun);
      }
    }
    if (
      blockedRun?.runId !== runId
      || blockedRun.status !== "needs_user"
      || blockedRun.blockedByHitlIds?.includes(input.hitlId) !== true
    ) {
      if (
        blockedRun?.runId === runId
        && blockedRun.status === "needs_user"
        && blockedRun.sessionId === input.rootSessionId
        && blockedRun.blockedByHitlIds?.includes(input.hitlId) !== true
        && blockedRun.jobId !== undefined
      ) {
        let advancedJob = await this.#jobQueue.read(blockedRun.jobId);
        if (advancedJob.status === "running") {
          advancedJob = await this.#jobCoordinator.reconcileReportedFinish(advancedJob, {
            status: "needs_user",
            summary: blockedRun.summary,
            blockedReason: blockedRun.blockedReason,
            blockedByHitlIds: blockedRun.blockedByHitlIds,
            attentionStatus: blockedRun.attentionStatus,
            resumeCheckpoint: blockedRun.resumeCheckpoint,
            worktreePath: blockedRun.worktreePath,
            worktreeBranchName: blockedRun.worktreeBranchName,
            baseSha: blockedRun.baseSha,
            resolvedHeadSha: blockedRun.resolvedHeadSha,
            cleanupState: blockedRun.cleanupState,
            cleanupWarning: blockedRun.cleanupWarning,
            observedArtifacts: blockedRun.observedArtifacts,
          });
        }
        if (advancedJob.status === "needs_user" && advancedJob.blockedByHitlIds?.includes(input.hitlId) !== true) {
          return this.#alreadyCompletedLease(blockedRun, advancedJob);
        }
      }
      throw new LoopSessionHitlContinuationConflictError(input.hitlId, "run_unexpected", `Loop ${input.origin.loopId} is not waiting on Session HITL ${input.hitlId} for run ${runId}`);
    }
    if (blockedRun.sessionId !== input.rootSessionId) {
      throw new LoopSessionHitlContinuationConflictError(input.hitlId, "session_mismatch", `Loop run ${runId} belongs to root Session ${blockedRun.sessionId ?? "<none>"}, not ${input.rootSessionId}`);
    }
    if (blockedRun.jobId === undefined) {
      throw new LoopSessionHitlContinuationConflictError(input.hitlId, "job_id_missing", `Loop run ${runId} has no durable job id`);
    }

    existingJob ??= await this.#jobQueue.read(blockedRun.jobId);
    const checkpoint = checkpointFor(input.hitlId, blockedRun, existingJob);
    // Persist the synthesized Session-owned checkpoint before claiming the job.
    // It is the write-ahead cursor used if the process dies with the job leased.
    const checkpointedRun: LoopRunReport = { ...blockedRun, resumeCheckpoint: checkpoint };
    await this.#stateManager.recordRunBlocked(blockedRun.loopId, checkpointedRun);
    const claim = await this.#jobCoordinator.resumeNeedsUser(blockedRun.jobId, input.hitlId, checkpoint);
    if (claim.outcome !== "claimed") {
      throw new LoopSessionHitlContinuationConflictError(
        input.hitlId,
        "job_unavailable",
        `Loop job ${blockedRun.jobId} cannot resume Session HITL ${input.hitlId}: ${claim.reason}`,
      );
    }

    const lease = executionLeaseFor(claim.job);
    const runningReport = runningContinuationReport(blockedRun);
    try {
      const collisionExpiresAt = collisionLeaseExpiresAtForRun(state, blockedRun.startedAt, this.#now());
      const collisionResults = await this.#collisionLedger.acquireAll((blockedRun.collisionTargets ?? []).map((target) => ({
        target,
        loopId: blockedRun.loopId,
        runId: blockedRun.runId,
        actionId: `session-hitl:${input.hitlId}`,
        priority: claim.job.priority,
        ...(collisionExpiresAt === undefined ? {} : { expiresAt: collisionExpiresAt }),
      })));
      if (collisionResults.some((result) => !result.acquired)) {
        throw new LoopSessionHitlContinuationConflictError(input.hitlId, "collision_conflict", `Loop run ${runId} could not reacquire its collision targets`);
      }
      await this.#stateManager.recordRunStart(blockedRun.loopId, runningReport);
      await this.#stateManager.clearHitlBlocker(blockedRun.loopId, input.hitlId);
    } catch (error) {
      await this.#rollbackAcquire(blockedRun, claim.job, lease, checkpoint, error);
      throw error;
    }

    return this.#lease({
      hitlId: input.hitlId,
      checkpoint,
      blockedRun,
      runningReport,
      job: claim.job,
      lease,
    });
  }

  async #convergeBlockedJobFromRun(job: LoopJobRecord, run: LoopRunReport): Promise<void> {
    const converged = await this.#jobCoordinator.reconcileReportedFinish(job, {
      status: "needs_user",
      summary: run.summary,
      blockedReason: run.blockedReason,
      blockedByHitlIds: run.blockedByHitlIds,
      attentionStatus: run.attentionStatus,
      resumeCheckpoint: run.resumeCheckpoint,
      worktreePath: run.worktreePath,
      worktreeBranchName: run.worktreeBranchName,
      baseSha: run.baseSha,
      resolvedHeadSha: run.resolvedHeadSha,
      cleanupState: run.cleanupState,
      cleanupWarning: run.cleanupWarning,
      observedArtifacts: run.observedArtifacts,
    });
    if (
      converged.status !== "needs_user"
      || !sameStringSet(converged.blockedByHitlIds ?? [], run.blockedByHitlIds ?? [])
      || converged.resumeCheckpoint?.hitlId !== run.resumeCheckpoint?.hitlId
    ) {
      throw new Error(`Loop job ${job.jobId} did not converge to run ${run.runId} Goal HITL checkpoint.`);
    }
  }

  async #convergeCurrentBlockedRun(input: {
    readonly runningReport: LoopRunReport;
    readonly job: LoopJobRecord;
  }): Promise<boolean> {
    const state = await this.#stateManager.read(input.runningReport.loopId);
    const authoritative = state.currentRun?.runId === input.runningReport.runId
      && state.currentRun.status === "needs_user"
      ? state.currentRun
      : undefined;
    if (authoritative === undefined) return false;
    const job = await this.#jobQueue.read(input.job.jobId);
    if (isTerminalJobStatus(job.status)) return false;
    await this.#convergeBlockedJobFromRun(job, authoritative);
    return true;
  }

  #alreadyCompletedLease(run: LoopRunReport, job: LoopJobRecord): SessionLoopHitlContinuationLease {
    return {
      alreadyCompleted: true,
      complete: async () => undefined,
      fail: async () => undefined,
      afterSessionRelease: () => {
        if (job.cleanupState !== "in_progress") return;
        this.#scheduleCleanup({ loopId: run.loopId, runId: run.runId, jobId: job.jobId });
      },
    };
  }

  #lease(input: {
    readonly hitlId: string;
    readonly checkpoint: LoopHitlCheckpoint;
    readonly blockedRun: LoopRunReport;
    readonly runningReport: LoopRunReport;
    readonly job: LoopJobRecord;
    readonly lease: LoopJobExecutionLease;
  }): SessionLoopHitlContinuationLease {
    let settled = false;
    let cleanupPending = false;
    let cleanupScheduled = false;
    let goalContinuationDispatchPending = false;

    const fail = async (error: unknown): Promise<void> => {
      if (settled) return;
      const currentState = await this.#stateManager.read(input.runningReport.loopId);
      const authoritativeBlockedRun = currentState.currentRun?.runId === input.runningReport.runId
        && currentState.currentRun.status === "needs_user";
      if (authoritativeBlockedRun) {
        try {
          if (!await this.#convergeCurrentBlockedRun(input) && !await this.#convergeTerminalFailure(input)) {
            throw new LoopSessionHitlContinuationConflictError(
              input.hitlId,
              "run_unexpected",
              `Loop run ${input.runningReport.runId} could not converge its authoritative Session HITL blockers`,
            );
          }
          settled = true;
          return;
        } finally {
          await this.#collisionLedger.releaseRun(input.runningReport.loopId, input.runningReport.runId);
        }
      }
      const report: LoopRunReport = {
        ...input.blockedRun,
        status: "needs_user",
        endedAt: this.#now(),
        summary: `Session HITL continuation failed: ${errorMessage(error)}`,
        blockedReason: "needs_user",
        blockedByHitlIds: [input.hitlId],
        attentionStatus: "waiting_for_human",
        resumeCheckpoint: input.checkpoint,
      };
      try {
        const stateResult = await this.#stateManager.recordRunBlockedIfCurrent(report.loopId, report);
        if (stateResult.outcome === "recorded") {
          try {
            await this.#jobCoordinator.finish(input.job.jobId, input.lease, blockedJobFinish(report, input.checkpoint));
          } catch (finishError) {
            if (!await this.#convergeTerminalFailure(input)) throw finishError;
          }
        } else if (!await this.#convergeTerminalFailure(input)) {
          throw new LoopSessionHitlContinuationConflictError(
            input.hitlId,
            "run_unexpected",
            `Loop run ${input.runningReport.runId} no longer owns the Session HITL continuation failure`,
          );
        }
      } finally {
        await this.#collisionLedger.releaseRun(input.runningReport.loopId, input.runningReport.runId);
      }
      settled = true;
    };

    return {
      complete: async ({ blockedByHitlIds }) => {
        if (settled) return;
        const remaining = blockedByHitlIds === undefined ? [] : [...blockedByHitlIds];
        if (remaining.length > 0) {
          const checkpoint = { ...input.checkpoint, hitlId: remaining[0]! };
          const report: LoopRunReport = {
            ...input.runningReport,
            status: "needs_user",
            endedAt: this.#now(),
            blockedReason: "needs_user",
            blockedByHitlIds: remaining,
            attentionStatus: "waiting_for_human",
            resumeCheckpoint: checkpoint,
            summary: `Session ${input.runningReport.sessionId ?? "<unknown>"} is waiting for additional user input.`,
          };
          await this.#stateManager.recordRunBlocked(report.loopId, report);
          try {
            await this.#jobCoordinator.finish(input.job.jobId, input.lease, {
              status: "needs_user",
              summary: report.summary,
              blockedReason: report.blockedReason,
              blockedByHitlIds: remaining,
              attentionStatus: report.attentionStatus,
              resumeCheckpoint: checkpoint,
            });
          } catch (finishError) {
            if (!await this.#convergeCurrentBlockedRun(input)) throw finishError;
          }
        } else if (input.runningReport.goalId !== undefined) {
          await this.#jobCoordinator.requeueGoalContinuation(input.job.jobId, input.lease);
          goalContinuationDispatchPending = true;
          settled = true;
          return;
        } else {
          const cleanupState = input.job.worktreePath === undefined ? input.job.cleanupState : "in_progress";
          const report: LoopRunReport = {
            ...input.runningReport,
            status: "succeeded",
            endedAt: this.#now(),
            blockedReason: undefined,
            blockedByHitlIds: undefined,
            attentionStatus: "clear",
            resumeCheckpoint: undefined,
            summary: `Session ${input.runningReport.sessionId ?? "<unknown>"} completed after user input.`,
            error: undefined,
            cleanupState,
          };
          await this.#stateManager.recordRunFinish(report.loopId, report);
          await this.#jobCoordinator.finish(input.job.jobId, input.lease, {
            status: "succeeded",
            summary: report.summary,
            attentionStatus: "clear",
            resumeCheckpoint: undefined,
            cleanupState,
          });
          cleanupPending = cleanupState === "in_progress";
        }
        await this.#collisionLedger.releaseRun(input.runningReport.loopId, input.runningReport.runId);
        settled = true;
      },
      fail,
      afterSessionRelease: () => {
        if (goalContinuationDispatchPending) {
          goalContinuationDispatchPending = false;
          this.#onGoalContinuationQueued?.({
            loopId: input.runningReport.loopId,
            jobId: input.job.jobId,
          });
          return;
        }
        if (!cleanupPending || cleanupScheduled) return;
        cleanupScheduled = true;
        this.#scheduleCleanup({
          loopId: input.runningReport.loopId,
          runId: input.runningReport.runId,
          jobId: input.job.jobId,
        });
      },
    };
  }

  /**
   * A terminal report is authoritative over a stale continuation failure. This
   * also closes the state-first/job-second crash window by conditionally
   * bringing a still-open queue record to the same terminal outcome.
   */
  async #convergeTerminalFailure(input: {
    readonly runningReport: LoopRunReport;
    readonly job: LoopJobRecord;
  }): Promise<boolean> {
    const state = await this.#stateManager.read(input.runningReport.loopId);
    const stateTerminal = state.lastRun?.runId === input.runningReport.runId
      && isTerminalRunStatus(state.lastRun.status)
      ? state.lastRun
      : undefined;
    const loggedTerminal = stateTerminal ?? (await this.#stateManager.readRunLog(input.runningReport.loopId))
      .find((report) => report.runId === input.runningReport.runId && isTerminalRunStatus(report.status));
    let job = await this.#jobQueue.read(input.job.jobId);

    if (loggedTerminal !== undefined) {
      await this.#stateManager.recoverRunProjection(input.runningReport.loopId, loggedTerminal);
      if (!isTerminalJobStatus(job.status)) {
        job = await this.#jobCoordinator.reconcileReportedFinish(job, terminalJobFinish(loggedTerminal));
      }
      return isTerminalJobStatus(job.status);
    }
    if (!isTerminalJobStatus(job.status)) return false;

    await this.#stateManager.recoverRunProjection(
      input.runningReport.loopId,
      terminalReportFromJob(input.runningReport, job, this.#now()),
    );
    return true;
  }

  async #rollbackAcquire(
    blockedRun: LoopRunReport,
    job: LoopJobRecord,
    lease: LoopJobExecutionLease,
    checkpoint: LoopHitlCheckpoint,
    originalError: unknown,
  ): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#stateManager.recordRunBlocked(blockedRun.loopId, {
        ...blockedRun,
        resumeCheckpoint: checkpoint,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#jobCoordinator.finish(job.jobId, lease, blockedJobFinish(blockedRun, checkpoint));
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#collisionLedger.releaseRun(blockedRun.loopId, blockedRun.runId);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError([originalError, ...failures], `Failed to roll back Loop Session HITL continuation ${checkpoint.hitlId}`);
    }
  }
}

function checkpointFor(hitlId: string, run: LoopRunReport, job: LoopJobRecord): LoopHitlCheckpoint {
  const existing = run.resumeCheckpoint?.hitlId === hitlId
    ? run.resumeCheckpoint
    : job.resumeCheckpoint?.hitlId === hitlId
      ? job.resumeCheckpoint
      : undefined;
  return existing ?? {
    version: 1,
    hitlId,
    loopId: run.loopId,
    runId: run.runId,
    ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
    trigger: run.trigger,
    ...(run.subjectKey === undefined ? {} : { subjectKey: run.subjectKey }),
    ...(run.worktreePath === undefined ? {} : { worktreePath: run.worktreePath }),
    ...(run.worktreeBranchName === undefined ? {} : { worktreeBranchName: run.worktreeBranchName }),
    ...(run.baseSha === undefined ? {} : { baseSha: run.baseSha }),
    ...(run.resolvedHeadSha === undefined ? {} : { resolvedHeadSha: run.resolvedHeadSha }),
    intendedContinuation: "resume_run",
  };
}

function runningContinuationReport(blocked: LoopRunReport): LoopRunReport {
  return {
    ...blocked,
    status: "running",
    endedAt: undefined,
    blockedReason: undefined,
    blockedByHitlIds: undefined,
    attentionStatus: "clear",
    resumeCheckpoint: undefined,
    skippedReason: undefined,
    error: undefined,
  };
}

function blockedJobFinish(run: LoopRunReport, checkpoint: LoopHitlCheckpoint) {
  return {
    status: "needs_user" as const,
    summary: run.summary,
    blockedReason: "needs_user",
    blockedByHitlIds: run.blockedByHitlIds ?? [checkpoint.hitlId],
    attentionStatus: "waiting_for_human" as const,
    resumeCheckpoint: checkpoint,
  };
}

function executionLeaseFor(job: LoopJobRecord): LoopJobExecutionLease {
  if (job.leaseOwnerId === undefined || job.leaseToken === undefined) {
    throw new Error(`Loop job ${job.jobId} is missing its continuation execution lease`);
  }
  return { leaseOwnerId: job.leaseOwnerId, leaseToken: job.leaseToken };
}

function terminalJobStatusForReport(report: LoopRunReport): "succeeded" | "failed" | "cancelled" | "skipped" {
  if (report.status === "succeeded") return "succeeded";
  if (report.status === "failed") return "failed";
  if (report.status === "cancelled") return "cancelled";
  return "skipped";
}

function isTerminalRunStatus(status: LoopRunReport["status"]): boolean {
  return status !== "running" && status !== "needs_user";
}

type TerminalLoopJobStatus = Extract<
  LoopJobRecord["status"],
  "succeeded" | "failed" | "cancelled" | "skipped" | "expired"
>;

function isTerminalJobStatus(status: LoopJobRecord["status"]): status is TerminalLoopJobStatus {
  return status === "succeeded"
    || status === "failed"
    || status === "cancelled"
    || status === "skipped"
    || status === "expired";
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function terminalJobFinish(report: LoopRunReport) {
  return {
    status: terminalJobStatusForReport(report),
    summary: report.summary,
    blockedReason: report.blockedReason,
    blockedByHitlIds: report.blockedByHitlIds,
    attentionStatus: report.attentionStatus,
    resumeCheckpoint: report.resumeCheckpoint,
    worktreePath: report.worktreePath,
    worktreeBranchName: report.worktreeBranchName,
    baseSha: report.baseSha,
    resolvedHeadSha: report.resolvedHeadSha,
    cleanupState: report.cleanupState,
    cleanupWarning: report.cleanupWarning,
    observedArtifacts: report.observedArtifacts,
  };
}

function terminalReportFromJob(
  runningReport: LoopRunReport,
  job: LoopJobRecord,
  endedAt: number,
): LoopRunReport {
  if (!isTerminalJobStatus(job.status)) {
    throw new Error(`Loop job ${job.jobId} is not terminal and cannot supply a terminal Session continuation report`);
  }
  const status = job.status === "expired"
    ? "skipped"
    : job.status;
  return {
    ...runningReport,
    status,
    endedAt: job.endedAt ?? endedAt,
    blockedReason: job.blockedReason,
    blockedByHitlIds: undefined,
    attentionStatus: "clear",
    resumeCheckpoint: undefined,
    worktreePath: job.worktreePath,
    worktreeBranchName: job.worktreeBranchName,
    baseSha: job.baseSha,
    resolvedHeadSha: job.resolvedHeadSha,
    cleanupState: job.cleanupState,
    cleanupWarning: job.cleanupWarning,
    observedArtifacts: job.observedArtifacts,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
