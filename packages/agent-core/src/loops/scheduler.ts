import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { LoopBudgetLedger } from "./budget-ledger";
import { CollisionLedger } from "./collision-ledger";
import { BunCronAdapter, type CronAdapter, type CronAdapterHandle } from "./cron-adapter";
import { LoopJobQueue } from "./job-queue";
import { LoopKillStateManager, type LoopKillActivateInput, type LoopKillState } from "./kill-state";
import { LoopActiveConflictError } from "./runner";
import type { CollisionConflict, CollisionTarget, LoopBudgetUsage, LoopIntegrationError, LoopRunReason, LoopRunReport, LoopRunReportStatus, LoopRunTrigger, LoopState, LoopTriggerHealth } from "./state";
import { LoopStateManager } from "./state";

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
}

export interface LoopSchedulerRunResult {
  readonly status?: Exclude<LoopRunReportStatus, "running" | "skipped">;
  readonly sessionId?: string;
  readonly goalId?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly reason?: LoopRunReason;
  readonly budgetUsage?: LoopBudgetUsage;
  readonly collisionTargets?: CollisionTarget[];
  readonly collisionConflicts?: CollisionConflict[];
  readonly integrationErrors?: LoopIntegrationError[];
}

export type LoopSchedulerRunner = (input: LoopSchedulerRunInput) => Promise<LoopSchedulerRunResult | void>;

interface ActiveSchedulerRun {
  readonly runId: string;
  readonly sessionId?: string;
}

export interface LoopSchedulerOptions {
  readonly stateManager: LoopStateManager;
  readonly runner: LoopSchedulerRunner;
  readonly clock?: LoopSchedulerClock;
  readonly timer?: LoopSchedulerTimer;
  readonly budgetLedger?: LoopBudgetLedger;
  readonly collisionLedger?: CollisionLedger;
  readonly jobQueue?: LoopJobQueue;
  readonly killStateManager?: LoopKillStateManager;
  readonly abortSessionExecutionAndWait?: (sessionId: string) => Promise<void>;
  readonly logger?: Logger;
  readonly cronAdapter?: CronAdapter;
}

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
  readonly #killStateManager?: LoopKillStateManager;
  readonly #abortSessionExecutionAndWait?: (sessionId: string) => Promise<void>;
  readonly #logger: Logger;
  readonly #timers = new Map<string, LoopSchedulerTimerHandle>();
  readonly #cronHandles = new Map<string, CronAdapterHandle>();
  readonly #activeRuns = new Map<string, ActiveSchedulerRun>();
  #disposed = false;

  constructor(options: LoopSchedulerOptions) {
    this.#stateManager = options.stateManager;
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
    this.#timer = options.timer ?? systemTimer;
    this.#cronAdapter = options.cronAdapter ?? new BunCronAdapter();
    this.#budgetLedger = options.budgetLedger;
    this.#collisionLedger = options.collisionLedger;
    this.#jobQueue = options.jobQueue;
    this.#killStateManager = options.killStateManager;
    this.#abortSessionExecutionAndWait = options.abortSessionExecutionAndWait;
    this.#logger = (options.logger ?? silentLogger).child({ module: "loops.scheduler" });
  }

  async start(projectId?: string): Promise<void> {
    if (this.#disposed) return;

    await this.#collisionLedger?.cleanupStale();
    const loops = await this.#stateManager.list(projectId);
    for (const loop of loops) {
      await this.scheduleLoopState(loop, { restart: true });
    }
  }

  async scheduleLoop(loopId: string): Promise<void> {
    if (this.#disposed) return;

    const loop = await this.#stateManager.read(loopId);
    await this.scheduleLoopState(loop, { restart: false });
  }

  async runManual(loopId: string): Promise<LoopRunReport | undefined> {
    if (this.#disposed) return undefined;

    const loop = await this.#stateManager.read(loopId);
    return await this.runLoop(loop, "manual");
  }

  async readKillState(): Promise<LoopKillState> {
    return await this.killStateManager().read();
  }

  async cancelCurrentRun(loopId: string): Promise<LoopRunReport | undefined> {
    return await this.cancelCurrentRunWithReason(loopId, "cancelled_by_user");
  }

  async activateGlobalKill(input: LoopKillActivateInput = {}): Promise<LoopKillState> {
    const state = await this.killStateManager().activate(input);

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
    return await this.#stateManager.pause(loopId);
  }

  async resume(loopId: string): Promise<LoopState> {
    const resumed = await this.#stateManager.resume(loopId, this.#clock.now());
    await this.scheduleLoopState(resumed, { restart: false });
    return resumed;
  }

  stop(): void {
    this.#disposed = true;
    this.clearAllTimers();
  }

  dispose(): void {
    this.stop();
  }

  private async scheduleLoopState(loop: LoopState, options: { restart: boolean }): Promise<void> {
    this.clearTimer(loop.loopId);
    if (this.#disposed) return;
    if (loop.status !== "active") return;
    if (await this.isGlobalKillActive()) return;

    if (loop.config.schedule.kind === "cron") {
      await this.scheduleCronLoopState(loop);
      return;
    }

    if (loop.config.schedule.kind !== "interval") return;

    const now = this.#clock.now();
    if (!options.restart && this.#activeRuns.has(loop.loopId) && (loop.nextRunAt ?? now) <= now) {
      await this.appendSkippedReport(loop.loopId, "interval", "Loop already has an active run; skipped overlapping interval tick.");
      return;
    }

    let nextRunAt = loop.nextRunAt;
    if (nextRunAt === undefined || nextRunAt <= now) {
      nextRunAt = now + loop.config.schedule.everyMs;
      loop = await this.#stateManager.update(loop.loopId, { nextRunAt });
    }

    const delayMs = Math.max(0, nextRunAt - this.#clock.now());
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
    await this.runLoop(loop, "interval");
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
    let nextScheduledAt = validation.nextFireAt;
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
    } catch (error) {
      await this.recordCronError(loopId, error);
    }
  }

  private async enqueueCronJob(loopId: string, scheduledAt: number, missedCount: number): Promise<void> {
    if (this.#jobQueue === undefined) {
      throw new Error("LoopScheduler requires LoopJobQueue to enqueue cron jobs.");
    }

    await this.#jobQueue.enqueue({
      loopId,
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

  private async runLoop(loop: LoopState, trigger: LoopRunTrigger): Promise<LoopRunReport | undefined> {
    if (this.#disposed) return undefined;

    const globalKillReport = await this.globalKillBlockedReport(loop, trigger);
    if (globalKillReport !== undefined) return globalKillReport;

    if (loop.status !== "active") {
      return await this.appendSkippedReport(loop.loopId, trigger, `Loop is ${loop.status}; skipped ${trigger} trigger.`, "loop_paused");
    }

    const activeRun = this.activeRunFor(loop);
    if (activeRun !== undefined) {
      if (trigger === "manual") {
        throw new LoopActiveConflictError(loop.loopId, trigger, activeRun.runId, activeRun.sessionId);
      }
      return await this.appendSkippedReport(loop.loopId, trigger, `Loop already has an active run; skipped overlapping ${trigger} trigger.`);
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
        );
      }
      return preRunBlocked;
    }
    const collisionResult = await this.acquireStaticCollisionTargets(loop, runId, trigger);
    if (collisionResult !== undefined) return collisionResult;
    const runningReport: LoopRunReport = {
      runId,
      loopId: loop.loopId,
      status: "running",
      trigger,
      startedAt,
      ...(loop.config.collisionTargets === undefined ? {} : { collisionTargets: loop.config.collisionTargets }),
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
      });
      return await this.finishRun(startedState, runningReport, {
        status: result?.status ?? "succeeded",
        sessionId: result?.sessionId,
        goalId: result?.goalId,
        summary: result?.summary,
        error: result?.error,
        reason: result?.reason,
        budgetUsage: result?.budgetUsage,
        collisionTargets: result?.collisionTargets,
        collisionConflicts: result?.collisionConflicts,
        integrationErrors: result?.integrationErrors,
      });
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
    result: Required<Pick<LoopSchedulerRunResult, "status">> & Omit<LoopSchedulerRunResult, "status">,
  ): Promise<LoopRunReport> {
    const latest = await this.#stateManager.read(loop.loopId);
    if (latest.lastRun?.runId === runningReport.runId && latest.lastRun.status !== "running") {
      await this.#collisionLedger?.releaseRun(loop.loopId, runningReport.runId);
      await this.#collisionLedger?.cleanupStale();
      return latest.lastRun;
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
      budgetUsage: result.budgetUsage,
      collisionTargets: result.collisionTargets ?? runningReport.collisionTargets,
      collisionConflicts: result.collisionConflicts,
      integrationErrors: result.integrationErrors,
      toolProfileId: loop.config.toolProfileId,
    };
    const finishedState = await this.#stateManager.recordRunFinish(loop.loopId, finishedReport);
    await this.#collisionLedger?.releaseRun(loop.loopId, runningReport.runId);
    await this.#collisionLedger?.cleanupStale();

    if (!this.#disposed) {
      await this.scheduleLoopState(finishedState, { restart: false });
    }

    return finishedReport;
  }

  private async appendSkippedReport(loopId: string, trigger: LoopRunTrigger, skippedReason: string, reason?: LoopRunReason): Promise<LoopRunReport> {
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
    };
    await this.#stateManager.appendRunReport(loopId, report);
    return report;
  }

  private async acquireStaticCollisionTargets(loop: LoopState, runId: string, trigger: LoopRunTrigger): Promise<LoopRunReport | undefined> {
    if (this.#collisionLedger === undefined || (loop.config.collisionTargets ?? []).length === 0) return undefined;

    const results = await this.#collisionLedger.acquireStaticTargets({
      loop,
      runId,
      priority: 0,
      actionId: `loop:${trigger}`,
    });
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
      skippedReason: "Loop static collision targets conflict with an active run; skipped trigger.",
      collisionTargets: loop.config.collisionTargets,
      collisionConflicts: conflicts,
      toolProfileId: loop.config.toolProfileId,
    };
    await this.#stateManager.appendRunReport(loop.loopId, report);
    return report;
  }

  private async cancelCurrentRunWithReason(loopId: string, reason: "cancelled_by_user" | "global_kill_active"): Promise<LoopRunReport | undefined> {
    let loop = await this.#stateManager.read(loopId);
    const running = loop.currentRun?.status === "running" ? loop.currentRun : undefined;
    if (running === undefined) return undefined;

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
    this.#activeRuns.delete(loopId);

    if (!this.#disposed && reason === "cancelled_by_user") {
      await this.scheduleLoopState(finishedState, { restart: false });
    }

    await abortPromise;
    return report;
  }

  private async globalKillBlockedReport(loop: LoopState, trigger: LoopRunTrigger): Promise<LoopRunReport | undefined> {
    if (!(await this.isGlobalKillActive())) return undefined;
    return await this.appendSkippedReport(loop.loopId, trigger, "Global Loop kill switch is active; skipped trigger.", "global_kill_active");
  }

  private async isGlobalKillActive(): Promise<boolean> {
    if (this.#killStateManager === undefined) return false;
    return (await this.#killStateManager.read()).globalKillActive;
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

    const cronHandle = this.#cronHandles.get(loopId);
    if (cronHandle === undefined) return;
    this.#cronAdapter.cancel(cronHandle);
    this.#cronHandles.delete(loopId);
  }

  private clearAllTimers(): void {
    for (const loopId of new Set([...this.#timers.keys(), ...this.#cronHandles.keys()])) {
      this.clearTimer(loopId);
    }
  }
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
