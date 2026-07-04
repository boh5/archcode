import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { LoopScheduler, type LoopSchedulerRunInput, type LoopSchedulerTimer } from "./scheduler";
import { LoopActiveConflictError } from "./runner";
import { LoopStateManager, type LoopConfig } from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-scheduler");

const manualConfig: LoopConfig = {
  title: "Manual loop",
  schedule: { kind: "manual" },
  runKind: "session",
  mode: "report",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 8 },
  taskPrompt: "Summarize the project",
};

const intervalConfig: LoopConfig = {
  ...manualConfig,
  title: "Interval loop",
  schedule: { kind: "interval", everyMs: 100 },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("LoopScheduler", () => {
  test("does not auto-schedule manual loops", async () => {
    const fixture = await createFixture();
    await fixture.manager.create("project-a", manualConfig);

    await fixture.scheduler.start("project-a");

    expect(fixture.timer.size()).toBe(0);
    expect(fixture.runs).toEqual([]);
  });

  test("schedules interval loops with fixed delay after completion", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 100 });
    fixture.runner = async () => {
      fixture.clock.set(150);
      return { summary: "finished after work" };
    };

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(100);

    const state = await fixture.manager.read(loop.loopId);
    expect(fixture.runs).toHaveLength(1);
    expect(state.lastRun?.status).toBe("succeeded");
    expect(state.lastRun?.endedAt).toBe(150);
    expect(state.nextRunAt).toBe(250);
    expect(fixture.timer.nextDue()).toBe(250);
  });

  test("skips missed interval ticks on restart without backfill", async () => {
    const fixture = await createFixture(1_000);
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 50 });

    await fixture.scheduler.start("project-a");

    expect(fixture.runs).toEqual([]);
    expect((await fixture.manager.read(loop.loopId)).nextRunAt).toBe(1_100);
    expect(fixture.timer.nextDue()).toBe(1_100);

    await fixture.timer.advanceTo(1_099);
    expect(fixture.runs).toEqual([]);

    await fixture.timer.advanceTo(1_100);
    expect(fixture.runs).toHaveLength(1);
  });

  test("keeps future persisted nextRunAt on restart", async () => {
    const fixture = await createFixture(1_000);
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 1_500 });

    await fixture.scheduler.start("project-a");

    expect((await fixture.manager.read(loop.loopId)).nextRunAt).toBe(1_500);
    expect(fixture.timer.nextDue()).toBe(1_500);
  });

  test("records skipped report for same-loop active interval tick without queuing another run", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 100 });
    const deferred = createDeferred<void>();
    const runnerStarted = createDeferred<void>();
    fixture.runner = async () => {
      runnerStarted.resolve();
      await deferred.promise;
      return { summary: "eventually done" };
    };

    await fixture.scheduler.start("project-a");
    const firstTick = fixture.timer.fireNextDue(100);
    await runnerStarted.promise;
    expect(fixture.runs).toHaveLength(1);

    await fixture.scheduler.scheduleLoop(loop.loopId);

    const skipped = (await fixture.manager.readRunLog(loop.loopId, 1))[0];
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.trigger).toBe("interval");
    expect(skipped?.skippedReason).toMatch(/active run/i);
    expect(fixture.timer.size()).toBe(0);

    fixture.clock.set(180);
    deferred.resolve();
    await firstTick;

    const reports = await fixture.manager.readRunLog(loop.loopId);
    expect(reports.map((report) => report.status)).toEqual(["succeeded", "skipped"]);
    expect(fixture.runs).toHaveLength(1);
    expect(fixture.timer.nextDue()).toBe(280);
  });

  test("manual trigger rejects same-loop active run with conflict instead of skipped report", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", manualConfig);
    const deferred = createDeferred<void>();
    const runnerStarted = createDeferred<void>();
    fixture.runner = async () => {
      runnerStarted.resolve();
      await deferred.promise;
      return { sessionId: "session-1", summary: "eventually done" };
    };

    const firstRun = fixture.scheduler.runManual(loop.loopId);
    await runnerStarted.promise;

    const conflict = await captureAsyncError(() => fixture.scheduler.runManual(loop.loopId));
    expect(conflict).toBeInstanceOf(LoopActiveConflictError);
    expect(conflict).toMatchObject({
      code: "LOOP_ACTIVE_CONFLICT",
      loopId: loop.loopId,
      trigger: "manual",
      activeRunId: fixture.runs[0]?.runId,
    });
    expect(fixture.runs).toHaveLength(1);
    expect(await fixture.manager.readRunLog(loop.loopId)).toEqual([]);

    fixture.clock.set(25);
    deferred.resolve();
    const report = await firstRun;

    expect(report).toMatchObject({ status: "succeeded", trigger: "manual", sessionId: "session-1" });
    const reports = await fixture.manager.readRunLog(loop.loopId);
    expect(reports.map((entry) => entry.status)).toEqual(["succeeded"]);
  });

  test("manual trigger rejects persisted currentRun conflict with deterministic details", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.manager.recordRunStart(loop.loopId, {
      runId: "persisted-run",
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: 10,
      sessionId: "persisted-session",
    });

    const conflict = await captureAsyncError(() => fixture.scheduler.runManual(loop.loopId));

    expect(conflict).toBeInstanceOf(LoopActiveConflictError);
    expect(conflict).toMatchObject({
      code: "LOOP_ACTIVE_CONFLICT",
      loopId: loop.loopId,
      trigger: "manual",
      activeRunId: "persisted-run",
      sessionId: "persisted-session",
    });
    expect(fixture.runs).toEqual([]);
    expect(await fixture.manager.readRunLog(loop.loopId)).toEqual([]);
  });

  test("pause clears future timer without cancelling an active run", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 100 });
    const deferred = createDeferred<void>();
    const runnerStarted = createDeferred<void>();
    fixture.runner = async () => {
      runnerStarted.resolve();
      await deferred.promise;
      return { summary: "completed while paused" };
    };

    await fixture.scheduler.start("project-a");
    const activeTick = fixture.timer.fireNextDue(100);
    await runnerStarted.promise;

    const paused = await fixture.scheduler.pause(loop.loopId);
    expect(paused.status).toBe("paused");
    expect(paused.currentRun?.status).toBe("running");
    expect(paused.nextRunAt).toBeUndefined();
    expect(fixture.timer.size()).toBe(0);

    fixture.clock.set(175);
    deferred.resolve();
    await activeTick;

    const finished = await fixture.manager.read(loop.loopId);
    expect(finished.status).toBe("paused");
    expect(finished.currentRun).toBeUndefined();
    expect(finished.lastRun?.status).toBe("succeeded");
    expect(finished.nextRunAt).toBeUndefined();
    expect(fixture.timer.size()).toBe(0);
  });

  test("resume schedules interval loop from current time", async () => {
    const fixture = await createFixture(500);
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.scheduler.pause(loop.loopId);

    const resumed = await fixture.scheduler.resume(loop.loopId);

    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).toBe(600);
    expect(fixture.timer.nextDue()).toBe(600);
  });

  test("stop clears timers and prevents new runs", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 100 });

    await fixture.scheduler.start("project-a");
    expect(fixture.timer.size()).toBe(1);

    fixture.scheduler.stop();
    expect(fixture.timer.size()).toBe(0);

    await fixture.timer.advanceTo(100);
    await fixture.scheduler.runManual(loop.loopId);

    expect(fixture.runs).toEqual([]);
  });
});

async function createFixture(now: number = 0): Promise<{
  manager: LoopStateManager;
  scheduler: LoopScheduler;
  clock: FakeClock;
  timer: FakeTimer;
  runs: LoopSchedulerRunInput[];
  runner: (input: LoopSchedulerRunInput) => Promise<{ summary: string } | void>;
}> {
  const manager = new LoopStateManager(TMP_DIR);
  const clock = new FakeClock(now);
  const timer = new FakeTimer(clock);
  const runs: LoopSchedulerRunInput[] = [];
  const fixture = {
    manager,
    scheduler: undefined as unknown as LoopScheduler,
    clock,
    timer,
    runs,
    runner: async (_input: LoopSchedulerRunInput) => ({ summary: "done" }),
  };
  fixture.scheduler = new LoopScheduler({
    stateManager: manager,
    clock,
    timer,
    runner: async (input) => {
      runs.push(input);
      return await fixture.runner(input);
    },
  });
  return fixture;
}

class FakeClock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  set(value: number): void {
    this.value = value;
  }
}

class FakeTimer implements LoopSchedulerTimer {
  readonly #tasks = new Map<number, { dueAt: number; callback: () => void | Promise<void> }>();
  #nextId = 1;

  constructor(private readonly clock: FakeClock) {}

  schedule(delayMs: number, callback: () => void | Promise<void>): { id: number } {
    const id = this.#nextId++;
    this.#tasks.set(id, { dueAt: this.clock.now() + delayMs, callback });
    return { id };
  }

  cancel(handle: { id?: unknown }): void {
    if (typeof handle.id === "number") this.#tasks.delete(handle.id);
  }

  async advanceTo(now: number): Promise<void> {
    while (true) {
      const next = this.nextTaskBefore(now);
      if (!next) break;

      await this.fireTask(next);
    }

    if (this.clock.now() < now) this.clock.set(now);
  }

  fireNextDue(now: number): Promise<void> {
    const next = this.nextTaskBefore(now);
    if (!next) throw new Error(`No timer due at or before ${now}`);
    return this.fireTask(next);
  }

  nextDue(): number | undefined {
    const dueTimes = Array.from(this.#tasks.values()).map((task) => task.dueAt);
    if (dueTimes.length === 0) return undefined;
    return Math.min(...dueTimes);
  }

  size(): number {
    return this.#tasks.size;
  }

  private nextTaskBefore(now: number): { id: number; task: { dueAt: number; callback: () => void | Promise<void> } } | undefined {
    let next: { id: number; task: { dueAt: number; callback: () => void | Promise<void> } } | undefined;
    for (const [id, task] of this.#tasks) {
      if (task.dueAt > now) continue;
      if (!next || task.dueAt < next.task.dueAt) next = { id, task };
    }
    return next;
  }

  private async fireTask(taskEntry: { id: number; task: { dueAt: number; callback: () => void | Promise<void> } }): Promise<void> {
    this.clock.set(taskEntry.task.dueAt);
    this.#tasks.delete(taskEntry.id);
    await taskEntry.task.callback();
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
}
