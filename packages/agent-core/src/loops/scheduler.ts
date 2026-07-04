import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { LoopBudgetLedger } from "./budget-ledger";
import { CollisionLedger } from "./collision-ledger";
import { LoopKillStateManager, type LoopKillActivateInput, type LoopKillState } from "./kill-state";
import { LoopActiveConflictError } from "./runner";
import type { LoopBudgetUsage, LoopRunReason, LoopRunReport, LoopRunReportStatus, LoopRunTrigger, LoopState } from "./state";
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
  readonly killStateManager?: LoopKillStateManager;
  readonly abortSessionExecutionAndWait?: (sessionId: string) => Promise<void>;
  readonly logger?: Logger;
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
  readonly #budgetLedger?: LoopBudgetLedger;
  readonly #collisionLedger?: CollisionLedger;
  readonly #killStateManager?: LoopKillStateManager;
  readonly #abortSessionExecutionAndWait?: (sessionId: string) => Promise<void>;
  readonly #logger: Logger;
  readonly #timers = new Map<string, LoopSchedulerTimerHandle>();
  readonly #activeRuns = new Map<string, ActiveSchedulerRun>();
  #disposed = false;

  constructor(options: LoopSchedulerOptions) {
    this.#stateManager = options.stateManager;
    this.#runner = options.runner;
    this.#clock = options.clock ?? systemClock;
    this.#timer = options.timer ?? systemTimer;
    this.#budgetLedger = options.budgetLedger;
    this.#collisionLedger = options.collisionLedger;
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
    if (loop.status !== "active" || loop.config.schedule.kind !== "interval") return;
    if (await this.isGlobalKillActive()) return;

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

  private async runLoop(loop: LoopState, trigger: LoopRunTrigger): Promise<LoopRunReport | undefined> {
    if (this.#disposed) return undefined;

    const globalKillReport = await this.globalKillBlockedReport(loop, trigger);
    if (globalKillReport !== undefined) return globalKillReport;

    const activeRun = this.activeRunFor(loop);
    if (activeRun !== undefined) {
      if (trigger === "manual") {
        throw new LoopActiveConflictError(loop.loopId, trigger, activeRun.runId, activeRun.sessionId);
      }
      return await this.appendSkippedReport(loop.loopId, trigger, `Loop already has an active run; skipped overlapping ${trigger} trigger.`);
    }

    const runId = crypto.randomUUID();
    const startedAt = this.#clock.now();
    const preRunBlocked = await this.#budgetLedger?.assertCanStartRun(loop, runId, trigger);
    if (preRunBlocked !== undefined) return preRunBlocked;
    const runningReport: LoopRunReport = {
      runId,
      loopId: loop.loopId,
      status: "running",
      trigger,
      startedAt,
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
    if (!handle) return;

    this.#timer.cancel(handle);
    this.#timers.delete(loopId);
  }

  private clearAllTimers(): void {
    for (const loopId of this.#timers.keys()) {
      this.clearTimer(loopId);
    }
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
