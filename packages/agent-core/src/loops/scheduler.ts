import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { LoopBudgetLedger } from "./budget-ledger";
import { canonicalTargetKey, CollisionLedger } from "./collision-ledger";
import { LoopJobCoordinator } from "./coordinator";
import { BunCronAdapter, type CronAdapter, type CronAdapterHandle } from "./cron-adapter";
import { LoopJobQueue, type EnqueueLoopJobInput, type EnqueueLoopJobResult, type LoopJobRecord } from "./job-queue";
import { LoopKillStateManager, type LoopKillActivateInput, type LoopKillState } from "./kill-state";
import { LoopActiveConflictError } from "./runner";
import type { CollisionConflict, CollisionTarget, LoopBudgetUsage, LoopCleanupState, LoopCoordinatorConfig, LoopIntegrationError, LoopJobStatus, LoopRunReason, LoopRunReport, LoopRunReportStatus, LoopRunTrigger, LoopState, LoopTriggerHealth, LoopWorktreeArtifact } from "./state";
import { LoopStateManager } from "./state";
import { LoopTriggerPoller } from "./triggers";

export interface LoopSchedulerClock {
  now(): number;
}

export interface LoopSchedulerTimer {
  schedule(delayMs: number, callback: () => void | Promise<void>): LoopSchedulerTimerHandle;
  cancel(handle: LoopSchedulerTimerHandle): void;
}

export interface LoopSchedulerTimerHandle {
  readonly id?: unknown;
}

export interface LoopSchedulerRunInput {
  readonly loop: LoopState;
  readonly trigger: LoopRunTrigger;
  readonly runId: string;
  readonly startedAt: number;
  readonly job?: LoopSchedulerRunJob;
}

export interface LoopSchedulerRunJob {
  readonly jobId: string;
  readonly triggerKind: LoopRunTrigger;
  readonly subjectKey: string;
  readonly dedupeKey: string;
  readonly branchKey?: string;
  readonly blockedReason?: string;
  readonly worktreePath?: string;
  readonly baseSha?: string;
  readonly resolvedHeadSha?: string;
  readonly missedCount?: number;
  readonly cleanupState?: LoopCleanupState;
  readonly observedArtifacts?: LoopWorktreeArtifact[];
}

export interface LoopSchedulerRunResult {
  readonly status?: Exclude<LoopRunReportStatus, "running">;
  readonly sessionId?: string;
  readonly goalId?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly reason?: LoopRunReason;
  readonly skippedReason?: string;
  readonly budgetUsage?: LoopBudgetUsage;
  readonly collisionTargets?: CollisionTarget[];
  readonly collisionConflicts?: CollisionConflict[];
  readonly integrationErrors?: LoopIntegrationError[];
  readonly blockedReason?: string;
  readonly worktreePath?: string;
  readonly baseSha?: string;
  readonly resolvedHeadSha?: string;
  readonly cleanupState?: LoopCleanupState;
  readonly observedArtifacts?: LoopWorktreeArtifact[];
}

export type LoopSchedulerRunner = (input: LoopSchedulerRunInput) => Promise<LoopSchedulerRunResult | void>;

interface ActiveSchedulerRun {
  readonly runId: string;
  readonly sessionId?: string;
}

interface ManualJobWaiter {
  readonly resolve: (report: LoopRunReport | undefined) => void;
  readonly reject: (error: unknown) => void;
}

export interface LoopSchedulerOptions {
  readonly stateManager: LoopStateManager;
  readonly runner: LoopSchedulerRunner;
  readonly clock?: LoopSchedulerClock;
  readonly timer?: LoopSchedulerTimer;
  readonly budgetLedger?: LoopBudgetLedger;
  readonly collisionLedger?: CollisionLedger;
  readonly jobQueue?: LoopJobQueue;
  readonly coordinator?: LoopJobCoordinator;
  readonly coordinatorConfig?: Partial<LoopCoordinatorConfig>;
  readonly killStateManager?: LoopKillStateManager;
  readonly abortSessionExecutionAndWait?: (sessionId: string) => Promise<void>;
  readonly logger?: Logger;
  readonly cronAdapter?: CronAdapter;
  readonly triggerPoller?: LoopTriggerPoller;
}

type LoopSchedulerFinishedRunResult = Required<Pick<LoopSchedulerRunResult, "status">> & Omit<LoopSchedulerRunResult, "status">;

const systemClock: LoopSchedulerClock = {
  now: () => Date.now(),
};

const systemTimer: LoopSchedulerTimer = {
  schedule: (delayMs, callback) => {
    const timer = setTimeout(() => {
      void callback();
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return { id: timer };
  },
  cancel: (handle) => {
    if (handle.id !== undefined) clearTimeout(handle.id as Timer);
  },
};

export class LoopScheduler {
  readonly #stateManager: LoopStateManager;
  readonly #runner: LoopSchedulerRunner;
  readonly #clock: LoopSchedulerClock;
  readonly #timer: LoopSchedulerTimer;
  readonly #cronAdapter: CronAdapter;
  readonly #budgetLedger?: LoopBudgetLedger;
  readonly #collisionLedger?: CollisionLedger;
  readonly #jobQueue?: LoopJobQueue;
  readonly #coordinator?: LoopJobCoordinator;
  readonly #killStateManager?: LoopKillStateManager;
  readonly #abortSessionExecutionAndWait?: (sessionId: string) => Promise<void>;
  readonly #logger: Logger;
  readonly #timers = new Map<string, LoopSchedulerTimerHandle>();
  readonly #triggerTimers = new Map<string, LoopSchedulerTimerHandle>();
  readonly #cronHandles = new Map<string, CronAdapterHandle>();
  #dispatchTimer: LoopSchedulerTimerHandle | undefined;
  readonly #activeRuns = new Map<string, ActiveSchedulerRun>();
  readonly #manualWaiters = new Map<string, ManualJobWaiter[]>();
  readonly #triggerPoller?: LoopTriggerPoller;
  #disposed = false;
  #started = false;
  #dispatching = false;
  #dispatchAgain = false;

  constructor(options: LoopSchedulerOptions) {
    this.#stateManager = options.stateManager;
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
    this.#timer = options.timer ?? systemTimer;
    this.#cronAdapter = options.cronAdapter ?? new BunCronAdapter();
    this.#budgetLedger = options.budgetLedger;
    this.#collisionLedger = options.collisionLedger;
    this.#jobQueue = options.jobQueue;
    this.#coordinator = options.coordinator ?? (options.jobQueue === undefined
      ? undefined
      : new LoopJobCoordinator({ queue: options.jobQueue, clock: this.#clock, config: options.coordinatorConfig }));
    this.#killStateManager = options.killStateManager;
    this.#abortSessionExecutionAndWait = options.abortSessionExecutionAndWait;
    this.#logger = (options.logger ?? silentLogger).child({ module: "loops.scheduler" });
    this.#triggerPoller = options.triggerPoller;
  }

  async start(projectId?: string): Promise<void> {
    if (this.#disposed || this.#started) return;
    this.#started = true;

    await this.#collisionLedger?.cleanupStale();
    await this.#coordinator?.start();
    await this.reconcileStaleCurrentRuns(projectId);
    const loops = await this.#stateManager.list(projectId);
    for (const loop of loops) {
      await this.scheduleLoopState(loop, { restart: true });
    }
    await this.dispatchReadyJobs();
  }

  async scheduleLoop(loopId: string): Promise<void> {
    if (this.#disposed) return;

    const loop = await this.#stateManager.read(loopId);
    await this.scheduleLoopState(loop, { restart: false });
  }

  async runManual(loopId: string): Promise<LoopRunReport | undefined> {
    if (this.#disposed) return undefined;

    const loop = await this.#stateManager.read(loopId);
    const globalKillReport = await this.globalKillBlockedReport(loop, "manual");
    if (globalKillReport !== undefined) return globalKillReport;
    if (loop.status !== "active") {
      return await this.appendSkippedReport(loop.loopId, "manual", `Loop is ${loop.status}; skipped manual trigger.`, "loop_paused");
    }
    const activeRun = this.activeRunFor(loop);
    if (activeRun !== undefined) throw new LoopActiveConflictError(loop.loopId, "manual", activeRun.runId, activeRun.sessionId);
    const enqueueResult = await this.enqueueLoopJob(loop, {
      triggerKind: "manual",
      subjectKey: `manual:${loop.loopId}`,
      eventSummary: {
        summary: `Manual trigger requested for loop "${loop.config.title}"`,
        source: "loop-scheduler-manual",
      },
    });
    if (enqueueResult === undefined) return undefined;
    return await this.dispatchAndWaitForManual(enqueueResult.job.jobId);
  }

  async readKillState(): Promise<LoopKillState> {
    return await this.killStateManager().read();
  }

  async cancelCurrentRun(loopId: string): Promise<LoopRunReport | undefined> {
    return await this.cancelCurrentRunWithReason(loopId, "cancelled_by_user");
  }

  async activateGlobalKill(input: LoopKillActivateInput = {}): Promise<LoopKillState> {
    const state = await this.killStateManager().activate(input);
    await this.cancelOpenJobs(undefined, "global_kill_active");

    const loops = await this.#stateManager.list();
    for (const loop of loops) {
      if (loop.currentRun?.status === "running") {
        await this.cancelCurrentRunWithReason(loop.loopId, "global_kill_active");
      }
    }
    return state;
  }

  async clearGlobalKill(): Promise<LoopKillState> {
    const state = await this.killStateManager().clear();
    const loops = await this.#stateManager.list();
    for (const loop of loops) {
      if (loop.status === "active") await this.scheduleLoopState(loop, { restart: false });
    }
    return state;
  }

  async pause(loopId: string): Promise<LoopState> {
    this.clearTimer(loopId);
    await this.cancelOpenJobs(loopId, "loop_paused");
    return await this.#stateManager.pause(loopId);
  }

  async resume(loopId: string): Promise<LoopState> {
    const resumed = await this.#stateManager.resume(loopId, this.#clock.now());
    await this.scheduleLoopState(resumed, { restart: false });
    return resumed;
  }

  async stop(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clearAllTimers();
    await this.requeueClaimedJobsWithoutCurrentRun();
    await this.settleManualWaitersOnStop();
  }

  dispose(): void {
    void this.stop();
  }

  private async scheduleLoopState(loop: LoopState, options: { restart: boolean }): Promise<void> {
    this.clearTimer(loop.loopId);
    if (this.#disposed) return;
    if (loop.status !== "active") return;
    if (await this.isGlobalKillActive()) return;

    if (loop.config.schedule.kind === "cron") {
      await this.scheduleCronLoopState(loop);
    } else if (loop.config.schedule.kind === "interval") {
      await this.scheduleIntervalLoopState(loop, options);
    }

    await this.scheduleTriggerPolling(loop);
  }

  private async scheduleIntervalLoopState(loop: LoopState, options: { restart: boolean }): Promise<void> {
    if (loop.config.schedule.kind !== "interval") return;
    const schedule = loop.config.schedule;
    const now = this.#clock.now();
    if (!options.restart && (this.#activeRuns.has(loop.loopId) || loop.currentRun?.status === "running") && (loop.nextRunAt ?? now) <= now) {
      await this.enqueueLoopJob(loop, {
        triggerKind: "interval",
        subjectKey: `interval:${loop.loopId}`,
        eventSummary: {
          summary: `Queued overlapping interval trigger for loop "${loop.config.title}"`,
          source: "loop-scheduler-interval",
        },
      });
      this.requestDispatch();
      return;
    }

    let nextRunAt = loop.nextRunAt;
    if (nextRunAt === undefined || nextRunAt <= now) {
      nextRunAt = now + schedule.everyMs;
      loop = await this.#stateManager.update(loop.loopId, { nextRunAt });
    }

    const scheduledRunAt = nextRunAt;
    const delayMs = Math.max(0, scheduledRunAt - this.#clock.now());
    const handle = this.#timer.schedule(delayMs, async () => {
      this.#timers.delete(loop.loopId);
      await this.runIntervalTick(loop.loopId);
    });
    this.#timers.set(loop.loopId, handle);
  }

  private async runIntervalTick(loopId: string): Promise<void> {
    if (this.#disposed) return;

    const loop = await this.#stateManager.read(loopId);
    if (loop.status !== "active" || loop.config.schedule.kind !== "interval") return;
    await this.enqueueLoopJob(loop, {
      triggerKind: "interval",
      subjectKey: `interval:${loop.loopId}`,
      eventSummary: {
        summary: `Queued interval trigger for loop "${loop.config.title}"`,
        source: "loop-scheduler-interval",
      },
    });
    this.requestDispatch();
  }

  private async scheduleTriggerPolling(loop: LoopState): Promise<void> {
    if (this.#triggerPoller === undefined || (loop.config.triggers ?? []).length === 0) return;

    const cadenceMs = Math.min(...(loop.config.triggers ?? []).map((trigger) => trigger.cadenceMs ?? 60_000));
    const handle = this.#timer.schedule(cadenceMs, async () => {
      this.#triggerTimers.delete(loop.loopId);
      await this.runTriggerPollTick(loop.loopId);
    });
    this.#triggerTimers.set(loop.loopId, handle);
  }

  private async runTriggerPollTick(loopId: string): Promise<void> {
    if (this.#disposed || this.#triggerPoller === undefined) return;
    try {
      const loop = await this.#stateManager.read(loopId);
      if (loop.status !== "active" || (loop.config.triggers ?? []).length === 0) return;
      if (await this.isGlobalKillActive()) return;
      await this.#triggerPoller.pollLoopState(loop);
      if (await this.isGlobalKillActive()) {
        await this.cancelOpenJobs(loopId, "global_kill_active");
        return;
      }
      this.requestDispatch();
      const latest = await this.#stateManager.read(loopId);
      await this.scheduleLoopState(latest, { restart: false });
    } catch (error) {
      this.#logger.warn("loops.scheduler.trigger_poll.failed", { error, meta: { loopId } });
    }
  }

  private async scheduleCronLoopState(loop: LoopState): Promise<void> {
    const expression = loop.config.schedule.kind === "cron" ? loop.config.schedule.expression : undefined;
    if (expression === undefined) return;

    const now = this.#clock.now();
    const validation = this.#cronAdapter.validate(expression, now);
    if (!validation.valid || validation.nextFireAt === undefined) {
      await this.recordTriggerHealth(loop.loopId, {
        status: "disabled",
        lastCheckedAt: now,
        lastError: validation.error ?? "Invalid cron expression.",
      });
      this.#logger.warn("loops.scheduler.cron.invalid", {
        meta: { loopId: loop.loopId, expression, error: validation.error },
      });
      return;
    }

    const catchUp = this.computeCronCatchUp(expression, loop.nextScheduledAt ?? loop.nextRunAt, now);
    let nextScheduledAt = loop.nextScheduledAt !== undefined && loop.nextScheduledAt > now ? loop.nextScheduledAt : validation.nextFireAt;
    if (catchUp !== undefined) {
      await this.enqueueCronJob(loop.loopId, catchUp.latestMissedAt, catchUp.missedCount);
      nextScheduledAt = catchUp.nextFutureAt;
    }

    await this.#stateManager.update(loop.loopId, {
      ...(catchUp === undefined ? {} : { lastScheduledAt: catchUp.latestMissedAt }),
      nextScheduledAt,
      nextRunAt: nextScheduledAt,
      ...(catchUp === undefined ? {} : { lastEnqueuedAt: catchUp.latestMissedAt }),
      missedCount: catchUp?.missedCount ?? loop.missedCount,
      triggerHealth: upsertCronHealth(loop.triggerHealth, {
        triggerKind: "cron",
        status: "healthy",
        lastCheckedAt: now,
        lastSuccessAt: now,
        missedCount: catchUp?.missedCount ?? loop.missedCount,
      }),
    });

    const handle = this.#cronAdapter.schedule(expression, (scheduledAt) => this.handleCronFire(loop.loopId, scheduledAt));
    this.#cronHandles.set(loop.loopId, handle);
  }

  private computeCronCatchUp(expression: string, persistedNextScheduledAt: number | undefined, now: number): { latestMissedAt: number; missedCount: number; nextFutureAt: number } | undefined {
    if (persistedNextScheduledAt === undefined || persistedNextScheduledAt > now) return undefined;

    let missedCount = 0;
    let latestMissedAt = persistedNextScheduledAt;
    let cursor = persistedNextScheduledAt;
    while (cursor <= now) {
      missedCount += 1;
      latestMissedAt = cursor;
      const next = this.#cronAdapter.nextFire(expression, cursor);
      if (next === undefined) break;
      cursor = next;
    }

    const nextFutureAt = cursor > now ? cursor : this.#cronAdapter.nextFire(expression, now);
    if (nextFutureAt === undefined) return undefined;
    return { latestMissedAt, missedCount, nextFutureAt };
  }

  private async handleCronFire(loopId: string, scheduledAt: number): Promise<void> {
    try {
      if (this.#disposed) return;
      const loop = await this.#stateManager.read(loopId);
      if (loop.status !== "active" || loop.config.schedule.kind !== "cron") return;
      if (await this.isGlobalKillActive()) return;

      const nextScheduledAt = this.#cronAdapter.nextFire(loop.config.schedule.expression, scheduledAt);
      await this.enqueueCronJob(loopId, scheduledAt, 0);
      await this.#stateManager.update(loopId, {
        lastScheduledAt: scheduledAt,
        nextScheduledAt,
        nextRunAt: nextScheduledAt,
        lastEnqueuedAt: scheduledAt,
        missedCount: 0,
        triggerHealth: upsertCronHealth(loop.triggerHealth, {
          triggerKind: "cron",
          status: "healthy",
          lastCheckedAt: this.#clock.now(),
          lastSuccessAt: this.#clock.now(),
          missedCount: 0,
        }),
      });
      this.requestDispatch();
    } catch (error) {
      await this.recordCronError(loopId, error);
    }
  }

  private async enqueueCronJob(loopId: string, scheduledAt: number, missedCount: number): Promise<void> {
    await this.enqueueLoopJob(await this.#stateManager.read(loopId), {
      triggerKind: "cron",
      subjectKey: `cron:${scheduledAt}`,
      queuedAt: this.#clock.now(),
      missedCount,
      eventSummary: {
        summary: missedCount > 0
          ? `Queued latest missed cron fire at ${new Date(scheduledAt).toISOString()} after ${missedCount} missed schedules`
          : `Queued cron fire at ${new Date(scheduledAt).toISOString()}`,
        source: "loop-scheduler-cron",
      },
    });
  }

  private async enqueueLoopJob(loop: LoopState, input: Omit<EnqueueLoopJobInput, "loopId">): Promise<EnqueueLoopJobResult | undefined> {
    if (this.#jobQueue === undefined) {
      throw new Error("LoopScheduler requires LoopJobQueue to enqueue loop jobs.");
    }

    const globalKillReport = await this.globalKillBlockedReport(loop, input.triggerKind);
    if (globalKillReport !== undefined) return undefined;
    if (loop.status !== "active") {
      await this.appendSkippedReport(loop.loopId, input.triggerKind, `Loop is ${loop.status}; skipped ${input.triggerKind} trigger.`, "loop_paused");
      return undefined;
    }

    return await this.#jobQueue.enqueue({
      ...input,
      loopId: loop.loopId,
      collisionTarget: input.collisionTarget ?? singleCollisionTarget(loop),
    });
  }

  private async dispatchAndWaitForManual(jobId: string): Promise<LoopRunReport | undefined> {
    const pending = new Promise<LoopRunReport | undefined>((resolve, reject) => {
      this.addManualWaiter(jobId, { resolve, reject });
    });
    await this.dispatchReadyJobs();
    if (!this.#manualWaiters.has(jobId)) return await pending;
    const latest = await this.#jobQueue?.read(jobId);
    if (latest !== undefined && isTerminalJobStatus(latest.status)) {
      const report = await this.reportForJob(latest) ?? await this.ensureTerminalReportForJob(latest);
      this.resolveManualWaiter(jobId, report);
      return await pending;
    }
    return await pending;
  }

  private async dispatchReadyJobs(): Promise<void> {
    if (this.#disposed || this.#coordinator === undefined || this.#jobQueue === undefined) return;
    if (await this.isGlobalKillActive()) return;
    if (this.#dispatching) {
      this.#dispatchAgain = true;
      return;
    }

    this.#dispatching = true;
    try {
      do {
        this.#dispatchAgain = false;
        const jobs = await this.#coordinator.dispatchReady();
        await Promise.all(jobs.map((job) => this.runQueuedJob(job)));
      } while (this.#dispatchAgain);
    } finally {
      this.#dispatching = false;
    }
  }

  private requestDispatch(): void {
    if (this.#disposed || this.#coordinator === undefined || this.#jobQueue === undefined) return;
    if (this.#dispatching) {
      this.#dispatchAgain = true;
      return;
    }
    if (this.#dispatchTimer !== undefined) return;
    this.#dispatchTimer = this.#timer.schedule(0, async () => {
      this.#dispatchTimer = undefined;
      await this.dispatchReadyJobs();
    });
  }

  private async runQueuedJob(job: LoopJobRecord): Promise<void> {
    try {
      if (this.#disposed) {
        const report = await this.cancelClaimedJobBeforeStart(job, "cancelled_by_user");
        this.resolveManualWaiter(job.jobId, report);
        return;
      }
      const loop = await this.#stateManager.read(job.loopId);
      if (this.#disposed) {
        const report = await this.cancelClaimedJobBeforeStart(job, "cancelled_by_user");
        this.resolveManualWaiter(job.jobId, report);
        return;
      }
      const report = await this.runLoop(loop, job);
      await this.finishQueuedJob(job, report);
      this.resolveManualWaiter(job.jobId, report);
    } catch (error) {
      this.rejectManualWaiter(job.jobId, error);
      await this.#coordinator?.finish(job.jobId, { status: "failed", summary: errorToMessage(error) });
      this.#logger.warn("loops.scheduler.queue_job.failed", { error, meta: { loopId: job.loopId, jobId: job.jobId } });
    } finally {
      if (!this.#disposed) await this.dispatchReadyJobs();
    }
  }

  private async finishQueuedJob(job: LoopJobRecord, report: LoopRunReport | undefined): Promise<void> {
    if (report === undefined) return;
    await this.#coordinator?.finish(job.jobId, {
      status: jobStatusFromRunReport(report),
      summary: report.summary ?? report.skippedReason ?? report.error,
      blockedReason: report.blockedReason ?? report.reason,
      worktreePath: updatedReportField(report.worktreePath, job.worktreePath),
      baseSha: updatedReportField(report.baseSha, job.baseSha),
      resolvedHeadSha: updatedReportField(report.resolvedHeadSha, job.resolvedHeadSha),
      cleanupState: report.cleanupState,
      observedArtifacts: report.observedArtifacts,
    });
  }

  private addManualWaiter(jobId: string, waiter: ManualJobWaiter): void {
    this.#manualWaiters.set(jobId, [...(this.#manualWaiters.get(jobId) ?? []), waiter]);
  }

  private resolveManualWaiter(jobId: string, report: LoopRunReport | undefined): void {
    for (const waiter of this.#manualWaiters.get(jobId) ?? []) waiter.resolve(report);
    this.#manualWaiters.delete(jobId);
  }

  private rejectManualWaiter(jobId: string, error: unknown): void {
    for (const waiter of this.#manualWaiters.get(jobId) ?? []) waiter.reject(error);
    this.#manualWaiters.delete(jobId);
  }

  private async reportForJob(job: LoopJobRecord): Promise<LoopRunReport | undefined> {
    const reports = await this.#stateManager.readRunLog(job.loopId);
    return reports.find((report) => report.jobId === job.jobId);
  }

  private async recordCronError(loopId: string, error: unknown): Promise<void> {
    const message = errorToMessage(error);
    this.#logger.warn("loops.scheduler.cron.failed", { error, meta: { loopId } });
    await this.recordTriggerHealth(loopId, {
      status: "degraded",
      lastCheckedAt: this.#clock.now(),
      lastError: message,
    });
  }

  private async recordTriggerHealth(loopId: string, health: Omit<LoopTriggerHealth, "triggerKind">): Promise<void> {
    const state = await this.#stateManager.read(loopId);
    await this.#stateManager.update(loopId, {
      triggerHealth: upsertCronHealth(state.triggerHealth, { triggerKind: "cron", ...health }),
    });
  }

  private async runLoop(loop: LoopState, job: LoopJobRecord): Promise<LoopRunReport | undefined> {
    if (this.#disposed) return await this.cancelClaimedJobBeforeStart(job, "cancelled_by_user");
    const trigger = job.triggerKind;

    const globalKillReport = await this.globalKillBlockedReport(loop, trigger, job);
    if (globalKillReport !== undefined) return globalKillReport;

    if (loop.status !== "active") {
      return await this.appendSkippedReport(loop.loopId, trigger, `Loop is ${loop.status}; skipped ${trigger} trigger.`, "loop_paused", job);
    }

    const activeRun = this.activeRunFor(loop);
    if (activeRun !== undefined) {
      if (trigger === "manual") {
        throw new LoopActiveConflictError(loop.loopId, trigger, activeRun.runId, activeRun.sessionId);
      }
      return await this.appendSkippedReport(loop.loopId, trigger, `Loop already has an active run; skipped overlapping ${trigger} trigger.`, "scheduler_overlap", job);
    }

    const runId = crypto.randomUUID();
    const startedAt = this.#clock.now();
    const preRunBlocked = await this.#budgetLedger?.assertCanStartRun(loop, runId, trigger, { recordReport: trigger !== "interval" });
    if (preRunBlocked !== undefined) {
      if (trigger === "interval") {
        return await this.appendSkippedReport(
          loop.loopId,
          trigger,
          preRunBlocked.summary ?? "Loop budget blocked interval trigger before run start.",
          preRunBlocked.reason ?? "hard_budget_exceeded",
          job,
        );
      }
      return attachJobFields(preRunBlocked, job);
    }
    const collisionTargets = collisionTargetsForRun(loop, job);
    const collisionResult = await this.acquireCollisionTargets(loop, job, runId, trigger, collisionTargets);
    if (collisionResult !== undefined) return collisionResult;
    const runningReport: LoopRunReport = {
      runId,
      loopId: loop.loopId,
      status: "running",
      trigger,
      startedAt,
      ...jobReportFields(job),
      ...(collisionTargets.length === 0 ? {} : { collisionTargets }),
    };

    this.#activeRuns.set(loop.loopId, { runId });
    let startedState = loop;
    try {
      startedState = await this.#stateManager.recordRunStart(loop.loopId, runningReport);
      await this.#budgetLedger?.recordRunStart(loop.loopId, runId);
      const result = await this.#runner({
        loop: startedState,
        trigger,
        runId,
        startedAt,
        job,
      });
      const report = await this.finishRun(startedState, runningReport, {
        status: result?.status ?? "succeeded",
        sessionId: result?.sessionId,
        goalId: result?.goalId,
        summary: result?.summary,
        error: result?.error,
        reason: result?.reason,
        skippedReason: result?.skippedReason,
        budgetUsage: result?.budgetUsage,
        collisionTargets: result?.collisionTargets,
        collisionConflicts: result?.collisionConflicts,
        integrationErrors: result?.integrationErrors,
        blockedReason: result?.blockedReason,
        worktreePath: result?.worktreePath,
        baseSha: result?.baseSha,
        resolvedHeadSha: result?.resolvedHeadSha,
        cleanupState: result?.cleanupState,
        observedArtifacts: result?.observedArtifacts,
      });
      this.rememberActiveSession(loop.loopId, report);
      return report;
    } catch (error) {
      this.#logger.warn("loops.scheduler.run.failed", {
        error,
        meta: { loopId: loop.loopId, runId, trigger },
      });
      return await this.finishRun(startedState, runningReport, {
        status: "failed",
        error: errorToMessage(error),
      });
    } finally {
      this.#activeRuns.delete(loop.loopId);
    }
  }

  private activeRunFor(loop: LoopState): ActiveSchedulerRun | undefined {
    const activeRun = this.#activeRuns.get(loop.loopId);
    if (activeRun !== undefined) return activeRun;
    if (loop.currentRun?.status === "running") {
      return { runId: loop.currentRun.runId, sessionId: loop.currentRun.sessionId };
    }
    return undefined;
  }

  private async finishRun(
    loop: LoopState,
    runningReport: LoopRunReport,
    result: LoopSchedulerFinishedRunResult,
  ): Promise<LoopRunReport> {
    const latest = await this.#stateManager.read(loop.loopId);
    if (latest.lastRun?.runId === runningReport.runId && latest.lastRun.status !== "running") {
      await this.#collisionLedger?.releaseRun(loop.loopId, runningReport.runId);
      await this.#collisionLedger?.cleanupStale();
      return { ...runningReport, ...latest.lastRun };
    }

    const finishedReport: LoopRunReport = {
      ...runningReport,
      status: result.status,
      endedAt: this.#clock.now(),
      sessionId: result.sessionId,
      goalId: result.goalId,
      summary: result.summary,
      error: result.error,
      reason: result.reason,
      skippedReason: result.skippedReason,
      budgetUsage: result.budgetUsage,
      collisionTargets: result.collisionTargets ?? runningReport.collisionTargets,
      collisionConflicts: result.collisionConflicts,
      integrationErrors: result.integrationErrors,
      toolProfileId: loop.config.toolProfileId,
      blockedReason: result.blockedReason,
      worktreePath: result.worktreePath ?? runningReport.worktreePath,
      baseSha: result.baseSha ?? runningReport.baseSha,
      resolvedHeadSha: result.resolvedHeadSha ?? runningReport.resolvedHeadSha,
      cleanupState: result.cleanupState ?? runningReport.cleanupState,
      observedArtifacts: result.observedArtifacts ?? runningReport.observedArtifacts,
    };
    const finishedState = await this.#stateManager.recordRunFinish(loop.loopId, finishedReport);
    await this.#collisionLedger?.releaseRun(loop.loopId, runningReport.runId);
    await this.#collisionLedger?.cleanupStale();

    if (!this.#disposed) {
      await this.scheduleLoopState(finishedState, { restart: false });
    }

    return finishedReport;
  }

  private async appendSkippedReport(loopId: string, trigger: LoopRunTrigger, skippedReason: string, reason?: LoopRunReason, job?: LoopJobRecord): Promise<LoopRunReport> {
    const now = this.#clock.now();
    const report: LoopRunReport = {
      runId: crypto.randomUUID(),
      loopId,
      status: "skipped",
      trigger,
      startedAt: now,
      endedAt: now,
      reason,
      skippedReason,
      ...(job === undefined ? {} : jobReportFields(job)),
    };
    await this.#stateManager.appendRunReport(loopId, report);
    return report;
  }

  private async acquireCollisionTargets(loop: LoopState, job: LoopJobRecord, runId: string, trigger: LoopRunTrigger, targets: readonly CollisionTarget[]): Promise<LoopRunReport | undefined> {
    if (this.#collisionLedger === undefined || targets.length === 0) return undefined;

    const results = await this.#collisionLedger.acquireAll(targets.map((target) => ({
      target,
      loopId: loop.loopId,
      runId,
      priority: 0,
      actionId: `loop:${trigger}`,
    })));
    const conflicts = results
      .map((result) => result.conflict)
      .filter((conflict): conflict is CollisionConflict => conflict !== undefined);
    if (conflicts.length === 0) return undefined;

    await this.#collisionLedger.releaseRun(loop.loopId, runId);
    await this.#collisionLedger.cleanupStale();
    const now = this.#clock.now();
    const report: LoopRunReport = {
      runId,
      loopId: loop.loopId,
      status: "skipped",
      trigger,
      startedAt: now,
      endedAt: now,
      reason: "collision_conflict",
      skippedReason: "Loop collision targets conflict with an active run; skipped trigger.",
      ...jobReportFields(job),
      collisionTargets: [...targets],
      collisionConflicts: conflicts,
      toolProfileId: loop.config.toolProfileId,
    };
    await this.#stateManager.appendRunReport(loop.loopId, report);
    return report;
  }

  private rememberActiveSession(loopId: string, report: LoopRunReport): void {
    if (report.sessionId === undefined) return;
    const activeRun = this.#activeRuns.get(loopId);
    if (activeRun?.runId === report.runId) this.#activeRuns.set(loopId, { runId: report.runId, sessionId: report.sessionId });
  }

  private async cancelCurrentRunWithReason(loopId: string, reason: "cancelled_by_user" | "global_kill_active"): Promise<LoopRunReport | undefined> {
    let loop = await this.#stateManager.read(loopId);
    const running = loop.currentRun?.status === "running" ? loop.currentRun : undefined;
    if (running === undefined) {
      const reports = await this.cancelOpenJobs(loopId, reason);
      return reports[0];
    }

    const abortPromise = running.sessionId === undefined
      ? Promise.resolve()
      : this.#abortSessionExecutionAndWait?.(running.sessionId) ?? Promise.resolve();

    loop = await this.#stateManager.read(loopId);
    if (loop.lastRun?.runId === running.runId && loop.lastRun.status !== "running") {
      await abortPromise;
      return loop.lastRun;
    }

    const current = loop.currentRun?.runId === running.runId ? loop.currentRun : running;
    const report: LoopRunReport = {
      ...current,
      status: "cancelled",
      endedAt: this.#clock.now(),
      reason,
      toolProfileId: loop.config.toolProfileId,
    };

    const finishedState = await this.#stateManager.recordRunFinish(loopId, report);
    await this.#collisionLedger?.releaseRun(loopId, running.runId);
    await this.#collisionLedger?.cleanupStale();
    if (running.jobId !== undefined) await this.#coordinator?.finish(running.jobId, { status: "cancelled", summary: reason });
    this.#activeRuns.delete(loopId);
    await this.cancelOpenJobs(loopId, reason);

    if (!this.#disposed && reason === "cancelled_by_user") {
      await this.scheduleLoopState(finishedState, { restart: false });
    }

    await abortPromise;
    return report;
  }

  private async globalKillBlockedReport(loop: LoopState, trigger: LoopRunTrigger, job?: LoopJobRecord): Promise<LoopRunReport | undefined> {
    if (!(await this.isGlobalKillActive())) return undefined;
    return await this.appendSkippedReport(loop.loopId, trigger, "Global Loop kill switch is active; skipped trigger.", "global_kill_active", job);
  }

  private async isGlobalKillActive(): Promise<boolean> {
    if (this.#killStateManager === undefined) return false;
    return (await this.#killStateManager.read()).globalKillActive;
  }

  private async cancelOpenJobs(loopId: string | undefined, reason: LoopRunReason): Promise<LoopRunReport[]> {
    if (this.#jobQueue === undefined) return [];
    const jobs = await this.#jobQueue.list(["pending", "queued", "running"]);
    const reports = await Promise.all(jobs
      .filter((job) => loopId === undefined || job.loopId === loopId)
      .map(async (job) => {
        if (job.status === "running") return undefined;
        const cancelled = await this.#jobQueue?.update(job.jobId, {
          status: "cancelled",
          blockedReason: reason,
          endedAt: this.#clock.now(),
          leaseExpiresAt: undefined,
          updatedAt: this.#clock.now(),
        });
        if (cancelled === undefined) return undefined;
        const report = await this.ensureCancelledJobReport(cancelled, reason);
        this.resolveManualWaiter(job.jobId, report);
        return report;
      }));
    return reports.filter((report): report is LoopRunReport => report !== undefined);
  }

  private async reconcileStaleCurrentRuns(projectId: string | undefined): Promise<void> {
    const loops = await this.#stateManager.list(projectId);
    const runningJobs = new Set((await this.#jobQueue?.list(["running"]) ?? []).map((job) => job.jobId));
    await Promise.all(loops.map(async (loop) => {
      const current = loop.currentRun;
      if (current?.status !== "running") return;
      if (current.jobId !== undefined && runningJobs.has(current.jobId)) return;
      const report: LoopRunReport = {
        ...current,
        status: "cancelled",
        endedAt: this.#clock.now(),
        reason: "cancelled_by_user",
        summary: "Recovered stale running loop state on scheduler startup.",
        toolProfileId: loop.config.toolProfileId,
      };
      await this.#stateManager.recordRunFinish(loop.loopId, report);
      await this.#collisionLedger?.releaseRun(loop.loopId, current.runId);
    }));
    await this.#collisionLedger?.cleanupStale();
  }

  private async settleManualWaitersOnStop(): Promise<void> {
    if (this.#manualWaiters.size === 0) return;
    const jobIds = [...this.#manualWaiters.keys()];
    await Promise.all(jobIds.map(async (jobId) => {
      const job = await this.#jobQueue?.read(jobId).catch(() => undefined);
      if (job === undefined) {
        this.resolveManualWaiter(jobId, undefined);
        return;
      }
      if (isTerminalJobStatus(job.status)) {
        this.resolveManualWaiter(jobId, await this.reportForJob(job) ?? await this.ensureTerminalReportForJob(job));
        return;
      }
      const loop = await this.#stateManager.read(job.loopId);
      if (job.status === "running" && loop.currentRun?.jobId === job.jobId && loop.currentRun.status === "running") {
        this.resolveManualWaiter(jobId, undefined);
        return;
      }
      const cancelled = await this.#jobQueue?.update(jobId, {
        status: "cancelled",
        blockedReason: "cancelled_by_user",
        endedAt: this.#clock.now(),
        leaseExpiresAt: undefined,
        updatedAt: this.#clock.now(),
      });
      this.resolveManualWaiter(jobId, cancelled === undefined ? undefined : await this.ensureCancelledJobReport(cancelled, "cancelled_by_user"));
    }));
  }

  private async cancelClaimedJobBeforeStart(job: LoopJobRecord, reason: LoopRunReason): Promise<LoopRunReport> {
    const cancelled = await this.#jobQueue?.update(job.jobId, {
      status: "cancelled",
      blockedReason: reason,
      endedAt: this.#clock.now(),
      leaseExpiresAt: undefined,
      updatedAt: this.#clock.now(),
    }) ?? job;
    return await this.ensureCancelledJobReport(cancelled, reason);
  }

  private async ensureTerminalReportForJob(job: LoopJobRecord): Promise<LoopRunReport> {
    if (job.status === "cancelled") return await this.ensureCancelledJobReport(job, loopRunReasonFromBlockedReason(job.blockedReason) ?? "cancelled_by_user");
    if (job.status === "skipped") return await this.ensureSkippedJobReport(job, loopRunReasonFromBlockedReason(job.blockedReason) ?? "scheduler_overlap");
    return await this.ensureSkippedJobReport(job, loopRunReasonFromBlockedReason(job.blockedReason) ?? "execution_failed");
  }

  private async ensureCancelledJobReport(job: LoopJobRecord, reason: LoopRunReason): Promise<LoopRunReport> {
    const existing = await this.reportForJob(job);
    if (existing !== undefined) return existing;
    const now = this.#clock.now();
    const report: LoopRunReport = {
      runId: crypto.randomUUID(),
      loopId: job.loopId,
      status: "cancelled",
      trigger: job.triggerKind,
      startedAt: job.startedAt ?? job.queuedAt,
      endedAt: now,
      reason,
      summary: `Queued loop job cancelled before execution: ${reason}`,
      ...jobReportFields(job),
    };
    await this.#stateManager.appendRunReport(job.loopId, report);
    return report;
  }

  private async ensureSkippedJobReport(job: LoopJobRecord, reason: LoopRunReason): Promise<LoopRunReport> {
    const existing = await this.reportForJob(job);
    if (existing !== undefined) return existing;
    const now = this.#clock.now();
    const report: LoopRunReport = {
      runId: crypto.randomUUID(),
      loopId: job.loopId,
      status: "skipped",
      trigger: job.triggerKind,
      startedAt: job.startedAt ?? job.queuedAt,
      endedAt: now,
      reason,
      skippedReason: job.blockedReason ?? `Queued loop job skipped before execution: ${reason}`,
      ...jobReportFields(job),
    };
    await this.#stateManager.appendRunReport(job.loopId, report);
    return report;
  }

  private async requeueClaimedJobsWithoutCurrentRun(): Promise<void> {
    if (this.#jobQueue === undefined) return;
    const runningJobs = await this.#jobQueue.list(["running"]);
    await Promise.all(runningJobs.map(async (job) => {
      const loop = await this.#stateManager.read(job.loopId);
      if (loop.currentRun?.jobId === job.jobId && loop.currentRun.status === "running") return;
      await this.#jobQueue?.update(job.jobId, {
        status: "pending",
        startedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt: this.#clock.now(),
      });
    }));
  }

  private killStateManager(): LoopKillStateManager {
    if (this.#killStateManager === undefined) {
      throw new Error("LoopScheduler requires a LoopKillStateManager for kill-state operations.");
    }
    return this.#killStateManager;
  }

  private clearTimer(loopId: string): void {
    const handle = this.#timers.get(loopId);
    if (handle !== undefined) {
      this.#timer.cancel(handle);
      this.#timers.delete(loopId);
    }

    const triggerHandle = this.#triggerTimers.get(loopId);
    if (triggerHandle !== undefined) {
      this.#timer.cancel(triggerHandle);
      this.#triggerTimers.delete(loopId);
    }

    const cronHandle = this.#cronHandles.get(loopId);
    if (cronHandle === undefined) return;
    this.#cronAdapter.cancel(cronHandle);
    this.#cronHandles.delete(loopId);
  }

  private clearAllTimers(): void {
    for (const loopId of new Set([...this.#timers.keys(), ...this.#triggerTimers.keys(), ...this.#cronHandles.keys()])) {
      this.clearTimer(loopId);
    }
    if (this.#dispatchTimer !== undefined) {
      this.#timer.cancel(this.#dispatchTimer);
      this.#dispatchTimer = undefined;
    }
  }
}

function singleCollisionTarget(loop: LoopState): CollisionTarget | undefined {
  const targets = loop.config.collisionTargets ?? [];
  return targets.length === 1 ? targets[0] : undefined;
}

function collisionTargetsForRun(loop: LoopState, job: LoopJobRecord): CollisionTarget[] {
  const targets = [...(loop.config.collisionTargets ?? [])];
  if (job.collisionTarget !== undefined && !targets.some((target) => canonicalTargetKey(target) === canonicalTargetKey(job.collisionTarget!))) {
    targets.push(job.collisionTarget);
  }
  return targets;
}

function jobReportFields(job: LoopJobRecord): Pick<LoopRunReport, "jobId" | "triggerKind" | "subjectKey" | "dedupeKey" | "branchKey" | "worktreePath" | "baseSha" | "resolvedHeadSha" | "missedCount" | "blockedReason" | "cleanupState" | "observedArtifacts"> {
  return {
    jobId: job.jobId,
    triggerKind: job.triggerKind,
    subjectKey: job.subjectKey,
    dedupeKey: job.dedupeKey,
    branchKey: job.branchKey,
    worktreePath: job.worktreePath,
    baseSha: job.baseSha,
    resolvedHeadSha: job.resolvedHeadSha,
    missedCount: job.missedCount,
    blockedReason: job.blockedReason,
    cleanupState: job.cleanupState,
    observedArtifacts: job.observedArtifacts,
  };
}

function attachJobFields(report: LoopRunReport, job: LoopJobRecord): LoopRunReport {
  return { ...report, ...jobReportFields(job) };
}

function jobStatusFromRunReport(report: LoopRunReport): Exclude<LoopJobStatus, "pending" | "queued" | "running"> {
  if (report.blockedReason === "needs_user" || report.blockedReason === "dirty-canonical") return "blocked";
  if (report.status === "succeeded") return "succeeded";
  if (report.status === "failed") return "failed";
  if (report.status === "cancelled") return "cancelled";
  return "skipped";
}

function updatedReportField<T>(reportValue: T | undefined, claimedJobValue: T | undefined): T | undefined {
  if (reportValue === undefined) return undefined;
  return reportValue === claimedJobValue ? undefined : reportValue;
}

function isTerminalJobStatus(status: LoopJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped" || status === "expired";
}

function loopRunReasonFromBlockedReason(reason: string | undefined): LoopRunReason | undefined {
  if (reason === undefined) return undefined;
  if (reason === "completed" || reason === "soft_budget_blocked" || reason === "hard_budget_exceeded" || reason === "collision_conflict" || reason === "cancelled_by_user" || reason === "global_kill_active" || reason === "loop_paused" || reason === "integration_auth_missing" || reason === "integration_rate_limited" || reason === "execution_failed" || reason === "max_steps_reached" || reason === "scheduler_overlap") {
    return reason;
  }
  return undefined;
}

function upsertCronHealth(existing: LoopState["triggerHealth"], next: NonNullable<LoopState["triggerHealth"]>[number]): NonNullable<LoopState["triggerHealth"]> {
  return [
    ...(existing ?? []).filter((entry) => entry.triggerKind !== "cron"),
    next,
  ];
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
