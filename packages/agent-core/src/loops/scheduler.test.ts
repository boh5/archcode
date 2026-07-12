import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { FakeCronAdapter } from "./cron-adapter";
import { LoopJobCoordinator } from "./coordinator";
import { LoopJobQueue, type LoopJobRecord } from "./job-queue";
import { LoopScheduler, type LoopSchedulerRunInput, type LoopSchedulerRunResult, type LoopSchedulerTimer } from "./scheduler";
import { LoopBudgetLedger } from "./budget-ledger";
import { CollisionLedger } from "./collision-ledger";
import { LoopKillStateManager } from "./kill-state";
import { LoopActiveConflictError, LoopGoalTurnContinuationPendingError, LoopWorktreeScopeCheckpointError, type ContinueLoopGoalRunInput } from "./runner";
import { LoopSessionHitlContinuationCoordinator } from "./session-hitl-continuation";
import { LoopStateManager, type LoopConfig } from "./state";
import { createLoopTestHitlService, FakeSessionFamilyStopper } from "./test-utils";
import { LoopTriggerPoller, type LoopLocalGitReader } from "./triggers";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-scheduler");

const manualConfig: LoopConfig = {
  templateId: "watch_report",
  title: "Manual loop",
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 8, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
  useWorktree: false,
  taskPrompt: "Summarize the project",
};

const intervalConfig: LoopConfig = {
  ...manualConfig,
  title: "Interval loop",
  schedule: { kind: "interval", everyMs: 100 },
};

const cronConfig: LoopConfig = {
  ...manualConfig,
  title: "Cron loop",
  schedule: { kind: "cron", expression: "*/15 * * * *" },
};

const triggerConfig: LoopConfig = {
  ...manualConfig,
  title: "Commit trigger loop",
  triggers: [{ kind: "on_commit", branch: "main", cadenceMs: 30_000 }],
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

  test("does not dispatch durable jobs before scheduler startup commits", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", manualConfig);
    const { job } = await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: `manual:${loop.loopId}`,
    });

    await fixture.scheduler.dispatchPendingJobs();
    expect(fixture.runs).toHaveLength(0);
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({ status: "pending" });

    await fixture.scheduler.start("project-a");
    expect(fixture.runs).toHaveLength(1);
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({ status: "succeeded" });
  });

  test("schedules interval loops through durable queue with fixed delay after completion", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 100 });
    fixture.runner = async () => {
      fixture.clock.set(150);
      return { status: "succeeded", summary: "finished after work" };
    };

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(100);

    const state = await fixture.manager.read(loop.loopId);
    const jobs = await fixture.jobQueue.list();
    expect(fixture.runs).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "succeeded", triggerKind: "interval", subjectKey: `interval:${loop.loopId}` });
    expect(state.lastRun?.status).toBe("succeeded");
    expect(state.lastRun).toMatchObject({ jobId: jobs[0]?.jobId, trigger: "interval", subjectKey: `interval:${loop.loopId}` });
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

  test("shares startup work, rolls back partial timers on failure, and permits one clean retry", async () => {
    const fixture = await createFixture(1_000);
    const firstLoop = await fixture.manager.create("project-a", intervalConfig);
    const secondLoop = await fixture.manager.create("project-a", { ...intervalConfig, title: "Second interval loop" });
    await fixture.manager.update(firstLoop.loopId, { nextRunAt: 2_000 });
    await fixture.manager.update(secondLoop.loopId, { nextRunAt: 2_000 });
    const originalSchedule = fixture.timer.schedule.bind(fixture.timer);
    let scheduleCalls = 0;
    let failSecondRegistration = true;
    Object.defineProperty(fixture.timer, "schedule", {
      value: (delayMs: number, callback: () => void | Promise<void>) => {
        scheduleCalls += 1;
        if (failSecondRegistration && scheduleCalls === 2) {
          failSecondRegistration = false;
          throw new Error("injected startup timer registration failure");
        }
        return originalSchedule(delayMs, callback);
      },
    });

    const firstStart = fixture.scheduler.start("project-a");
    const concurrentStart = fixture.scheduler.start("project-a");
    const firstAttempts = await Promise.allSettled([firstStart, concurrentStart]);

    expect(firstAttempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
    expect(scheduleCalls).toBe(2);
    expect(fixture.timer.size()).toBe(0);
    expect(fixture.cron.size()).toBe(0);

    await fixture.scheduler.start("project-a");

    expect(scheduleCalls).toBe(4);
    expect(fixture.timer.size()).toBe(2);
    expect(fixture.cron.size()).toBe(0);
    expect(await fixture.jobQueue.list()).toEqual([]);

    await fixture.scheduler.start("project-a");
    expect(scheduleCalls).toBe(4);
    expect(fixture.timer.size()).toBe(2);
  });

  test("coalesces same-loop active interval tick without directly starting another runner", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 100 });
    const deferred = createDeferred<void>();
    const runnerStarted = createDeferred<void>();
    fixture.runner = async () => {
      runnerStarted.resolve();
      await deferred.promise;
      return { status: "succeeded", summary: "eventually done" };
    };

    await fixture.scheduler.start("project-a");
    await fixture.timer.fireNextDue(100);
    const firstTick = fixture.timer.fireNextDue(100);
    await runnerStarted.promise;
    expect(fixture.runs).toHaveLength(1);

    await fixture.scheduler.scheduleLoop(loop.loopId);

    const runningJob = (await fixture.jobQueue.list())[0];
    expect(runningJob).toMatchObject({ status: "running", triggerKind: "interval", rerunAfterCurrent: true });
    expect(fixture.timer.size()).toBe(0);

    fixture.clock.set(180);
    deferred.resolve();
    await firstTick;

    const reports = await fixture.manager.readRunLog(loop.loopId);
    expect(reports.map((report) => report.status)).toEqual(["succeeded", "succeeded"]);
    expect(fixture.runs).toHaveLength(2);
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
      return { status: "succeeded", sessionId: "session-1", summary: "eventually done" };
    };

    const firstRun = fixture.scheduler.runManual(loop.loopId);
    await runnerStarted.promise;
    expect((await fixture.jobQueue.list())[0]).toMatchObject({ status: "running", triggerKind: "manual", subjectKey: `manual:${loop.loopId}` });

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
    expect(report?.jobId).toBeString();
    const reports = await fixture.manager.readRunLog(loop.loopId);
    expect(reports.map((entry) => entry.status)).toEqual(["succeeded"]);
  });

  test("exposes a durable worktree checkpoint writer to the queued runner", async () => {
    const fixture = await createFixture(30);
    const loop = await fixture.manager.create("project-a", manualConfig);
    const checkpoint = {
      worktreePath: "/tmp/scheduler-checkpoint-worktree",
      worktreeBranchName: "archcode/loop/test/scheduler-checkpoint",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "b".repeat(40),
    };
    fixture.runner = async (input) => {
      expect(input.checkpointBaseSha).toBeFunction();
      expect(input.checkpointWorktree).toBeFunction();
      await input.checkpointBaseSha(checkpoint.baseSha);
      expect(await fixture.jobQueue.read(input.job.jobId)).toMatchObject({
        status: "running",
        baseSha: checkpoint.baseSha,
      });
      await input.checkpointWorktree(checkpoint);
      expect(await fixture.jobQueue.read(input.job.jobId)).toMatchObject({
        status: "running",
        ...checkpoint,
      });
      return { status: "succeeded", summary: "checkpointed" };
    };

    await fixture.scheduler.runManual(loop.loopId);

    expect((await fixture.jobQueue.list())[0]).toMatchObject({ status: "succeeded", ...checkpoint });
  });

  test("retries the same job after phase-two checkpoint failure instead of terminally losing its orphan", async () => {
    const fixture = await createFixture(31);
    const loop = await fixture.manager.create("project-a", manualConfig);
    const baseSha = "c".repeat(40);
    let attempts = 0;
    fixture.runner = async (input) => {
      attempts += 1;
      await input.checkpointBaseSha!(baseSha);
      if (attempts === 1) {
        throw new LoopWorktreeScopeCheckpointError(
          "/tmp/retryable-uncheckpointed-worktree",
          "cleaned",
          new Error("phase two persistence failed"),
        );
      }
      return { status: "succeeded", summary: "retry completed" };
    };

    const report = await fixture.scheduler.runManual(loop.loopId);

    expect(report).toMatchObject({ status: "succeeded", summary: "retry completed" });
    expect(attempts).toBe(2);
    const [job] = await fixture.jobQueue.list();
    expect(job).toMatchObject({
      status: "succeeded",
      attempts: 2,
      baseSha,
    });
    expect(job?.worktreePath).toBeUndefined();
    expect((await fixture.manager.readRunLog(loop.loopId)).map((entry) => entry.status)).toEqual(["succeeded", "failed"]);
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

  test("multiple manual callers waiting on the same queued job settle with one job-specific cancel report", async () => {
    const fixture = await createFixture(100);
    const singleSlotCoordinator = new LoopJobCoordinator({ queue: fixture.jobQueue, clock: fixture.clock, leaseTtlMs: 60_000, config: { maxConcurrent: 1 } });
    fixture.scheduler = fixture.createScheduler(undefined, singleSlotCoordinator);
    const loop = await fixture.manager.create("project-a", manualConfig);
    const blocker = await fixture.manager.create("project-a", manualConfig);
    await fixture.manager.appendRunReport(loop.loopId, {
      runId: "old-run",
      loopId: loop.loopId,
      status: "succeeded",
      trigger: "manual",
      startedAt: 1,
      endedAt: 2,
      summary: "old unrelated report",
    });
    const { job: blockingJob } = await fixture.jobQueue.enqueue({
      loopId: blocker.loopId,
      triggerKind: "manual",
      subjectKey: "manual:blocker",
      eventSummary: { summary: "occupy coordinator slot" },
    });
    await fixture.jobQueue.update(blockingJob.jobId, {
      status: "running",
      startedAt: 50,
      leaseExpiresAt: 10_000,
      leaseOwnerId: "manual-blocker",
      leaseToken: "manual-blocker-lease-1",
      attempts: 1,
    });

    const first = fixture.scheduler.runManual(loop.loopId);
    const second = fixture.scheduler.runManual(loop.loopId);
    await waitFor(() => fixture.jobQueue.list().then((jobs) => jobs.some((job) => job.loopId === loop.loopId && job.status === "pending")));
    const queued = (await fixture.jobQueue.list()).find((job) => job.loopId === loop.loopId && job.subjectKey === `manual:${loop.loopId}`)!;

    await fixture.scheduler.pause(loop.loopId);
    const reports = await Promise.all([first, second]);

    expect(reports[0]).toEqual(reports[1]);
    expect(reports[0]).toMatchObject({
      status: "cancelled",
      trigger: "manual",
      reason: "loop_paused",
      jobId: queued.jobId,
      subjectKey: `manual:${loop.loopId}`,
      dedupeKey: queued.dedupeKey,
    });
    expect(reports[0]?.runId).not.toBe("old-run");
    expect((await fixture.manager.readRunLog(loop.loopId, 1))[0]).toMatchObject({ jobId: queued.jobId, status: "cancelled", reason: "loop_paused" });
    expect((await fixture.jobQueue.read(queued.jobId))).toMatchObject({ status: "cancelled", blockedReason: "loop_paused" });
    expect(fixture.runs).toEqual([]);
  });

  test("cancelCurrentRun cancels queued manual job and settles waiter with job-specific report", async () => {
    const fixture = await createFixture(125);
    const singleSlotCoordinator = new LoopJobCoordinator({ queue: fixture.jobQueue, clock: fixture.clock, leaseTtlMs: 60_000, config: { maxConcurrent: 1 } });
    fixture.scheduler = fixture.createScheduler(undefined, singleSlotCoordinator);
    const loop = await fixture.manager.create("project-a", manualConfig);
    const blocker = await fixture.manager.create("project-a", manualConfig);
    await fixture.manager.appendRunReport(loop.loopId, {
      runId: "old-run",
      loopId: loop.loopId,
      status: "succeeded",
      trigger: "manual",
      startedAt: 1,
      endedAt: 2,
      summary: "old unrelated report",
    });
    const { job: blockingJob } = await fixture.jobQueue.enqueue({
      loopId: blocker.loopId,
      triggerKind: "manual",
      subjectKey: "manual:blocker",
      eventSummary: { summary: "occupy coordinator slot" },
    });
    await fixture.jobQueue.update(blockingJob.jobId, {
      status: "running",
      startedAt: 50,
      leaseExpiresAt: 10_000,
      leaseOwnerId: "manual-blocker",
      leaseToken: "manual-blocker-lease-2",
      attempts: 1,
    });

    const waiter = fixture.scheduler.runManual(loop.loopId);
    await waitFor(() => fixture.jobQueue.list().then((jobs) => jobs.some((job) => job.loopId === loop.loopId && job.status === "pending")));
    const queued = (await fixture.jobQueue.list()).find((job) => job.loopId === loop.loopId && job.subjectKey === `manual:${loop.loopId}`)!;

    const cancelled = await fixture.scheduler.cancelCurrentRun(loop.loopId);
    const waited = await waiter;

    expect(waited).toEqual(cancelled);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      trigger: "manual",
      reason: "cancelled_by_user",
      jobId: queued.jobId,
      subjectKey: `manual:${loop.loopId}`,
      dedupeKey: queued.dedupeKey,
    });
    expect(cancelled?.runId).not.toBe("old-run");
    expect((await fixture.jobQueue.read(queued.jobId))).toMatchObject({ status: "cancelled", blockedReason: "cancelled_by_user" });
    expect((await fixture.manager.readRunLog(loop.loopId, 1))[0]).toMatchObject({ jobId: queued.jobId, status: "cancelled", reason: "cancelled_by_user" });
    expect(fixture.runs).toEqual([]);
  });

  test("claimed manual job stopped before runLoop starts settles waiter and clears lease", async () => {
    const fixture = await createFixture(200);
    const loop = await fixture.manager.create("project-a", manualConfig);
    const realCoordinator = fixture.coordinator;
    let stoppedDuringDispatch = false;
    const coordinator = {
      get maxConcurrent() {
        return realCoordinator.maxConcurrent;
      },
      recoverStaleRunning: () => realCoordinator.recoverStaleRunning(),
      start: () => realCoordinator.start(),
      finish: (...args: Parameters<LoopJobCoordinator["finish"]>) => realCoordinator.finish(...args),
      dispatchReady: async () => {
        const jobs = await realCoordinator.dispatchReady();
        if (!stoppedDuringDispatch && jobs.length > 0) {
          stoppedDuringDispatch = true;
          await fixture.scheduler.stop();
        }
        return jobs;
      },
    } as unknown as LoopJobCoordinator;
    fixture.scheduler = fixture.createScheduler(undefined, coordinator);

    const report = await fixture.scheduler.runManual(loop.loopId);
    const job = (await fixture.jobQueue.list())[0]!;

    expect(report).toMatchObject({
      status: "cancelled",
      trigger: "manual",
      reason: "cancelled_by_user",
      jobId: job.jobId,
      subjectKey: `manual:${loop.loopId}`,
      dedupeKey: job.dedupeKey,
    });
    expect(job).toMatchObject({ status: "cancelled", blockedReason: "cancelled_by_user" });
    expect(job.leaseExpiresAt).toBeUndefined();
    expect((await fixture.manager.readRunLog(loop.loopId, 1))[0]).toMatchObject({ jobId: job.jobId, status: "cancelled", reason: "cancelled_by_user" });
    expect(fixture.runs).toEqual([]);
  });

  test("queued job skipped by global kill after claim keeps queue metadata", async () => {
    const fixture = await createFixture(200);
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 225 });
    const realCoordinator = fixture.coordinator;
    const coordinator = {
      get maxConcurrent() {
        return realCoordinator.maxConcurrent;
      },
      recoverStaleRunning: () => realCoordinator.recoverStaleRunning(),
      start: () => realCoordinator.start(),
      finish: (...args: Parameters<LoopJobCoordinator["finish"]>) => realCoordinator.finish(...args),
      dispatchReady: async () => {
        const jobs = await realCoordinator.dispatchReady();
        if (jobs.length > 0) await fixture.scheduler.activateGlobalKill({ reason: "kill after claim" });
        return jobs;
      },
    } as unknown as LoopJobCoordinator;
    fixture.scheduler = fixture.createScheduler(undefined, coordinator);

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(225);

    const job = (await fixture.jobQueue.list())[0]!;
    const report = (await fixture.manager.readRunLog(loop.loopId, 1))[0];
    expect(report).toMatchObject({
      status: "skipped",
      trigger: "interval",
      reason: "global_kill_active",
      jobId: job.jobId,
      subjectKey: `interval:${loop.loopId}`,
      dedupeKey: job.dedupeKey,
    });
    expect(job).toMatchObject({ status: "skipped", blockedReason: "global_kill_active" });
    expect(fixture.runs).toEqual([]);
  });

  test("queued job skipped by paused loop after claim keeps queue metadata", async () => {
    const fixture = await createFixture(200);
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 250 });
    const realCoordinator = fixture.coordinator;
    const coordinator = {
      get maxConcurrent() {
        return realCoordinator.maxConcurrent;
      },
      recoverStaleRunning: () => realCoordinator.recoverStaleRunning(),
      start: () => realCoordinator.start(),
      finish: (...args: Parameters<LoopJobCoordinator["finish"]>) => realCoordinator.finish(...args),
      dispatchReady: async () => {
        const jobs = await realCoordinator.dispatchReady();
        if (jobs.length > 0) await fixture.manager.pause(loop.loopId);
        return jobs;
      },
    } as unknown as LoopJobCoordinator;
    fixture.scheduler = fixture.createScheduler(undefined, coordinator);

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(250);

    const job = (await fixture.jobQueue.list())[0]!;
    const report = (await fixture.manager.readRunLog(loop.loopId, 1))[0];
    expect(report).toMatchObject({
      status: "skipped",
      trigger: "interval",
      reason: "loop_paused",
      jobId: job.jobId,
      subjectKey: `interval:${loop.loopId}`,
      dedupeKey: job.dedupeKey,
    });
    expect(job).toMatchObject({ status: "skipped", blockedReason: "loop_paused" });
    expect(fixture.runs).toEqual([]);
  });

  test("queued interval overlap skipped after claim keeps queue metadata", async () => {
    const fixture = await createFixture(200);
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 275 });
    const realCoordinator = fixture.coordinator;
    const coordinator = {
      get maxConcurrent() {
        return realCoordinator.maxConcurrent;
      },
      recoverStaleRunning: () => realCoordinator.recoverStaleRunning(),
      start: () => realCoordinator.start(),
      finish: (...args: Parameters<LoopJobCoordinator["finish"]>) => realCoordinator.finish(...args),
      dispatchReady: async () => {
        const jobs = await realCoordinator.dispatchReady();
        if (jobs.length > 0) {
          await fixture.manager.recordRunStart(loop.loopId, {
            runId: "persisted-active-run",
            loopId: loop.loopId,
            status: "running",
            trigger: "interval",
            startedAt: 270,
          });
        }
        return jobs;
      },
    } as unknown as LoopJobCoordinator;
    fixture.scheduler = fixture.createScheduler(undefined, coordinator);

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(275);

    const job = (await fixture.jobQueue.list())[0]!;
    const report = (await fixture.manager.readRunLog(loop.loopId, 1))[0];
    expect(report).toMatchObject({
      status: "skipped",
      trigger: "interval",
      reason: "scheduler_overlap",
      jobId: job.jobId,
      subjectKey: `interval:${loop.loopId}`,
      dedupeKey: job.dedupeKey,
    });
    expect(job).toMatchObject({ status: "skipped", blockedReason: "scheduler_overlap" });
    expect(fixture.runs).toEqual([]);
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
      return { status: "succeeded", summary: "completed while paused" };
    };

    await fixture.scheduler.start("project-a");
    await fixture.timer.fireNextDue(100);
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

  test("cancelCurrentRun stops the linked Session family and records cancelled_by_user in run log", async () => {
    const fixture = await createFixture(1_000);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.manager.recordRunStart(loop.loopId, {
      runId: "run-cancel",
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: 900,
      sessionId: "session-cancel",
    });

    const report = await fixture.scheduler.cancelCurrentRun(loop.loopId);

    expect(report).toMatchObject({
      runId: "run-cancel",
      status: "cancelled",
      reason: "cancelled_by_user",
      endedAt: 1_000,
      sessionId: "session-cancel",
    });
    fixture.executionManager.assertCallCount("stopSessionFamily", 1);
    expect(fixture.executionManager.getCalls("stopSessionFamily")[0]).toMatchObject({
      workspaceRoot: TMP_DIR,
      sessionId: "session-cancel",
    });
    const state = await fixture.manager.read(loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun).toMatchObject({ status: "cancelled", reason: "cancelled_by_user" });
    expect((await fixture.manager.readRunLog(loop.loopId, 1))[0]).toMatchObject({ status: "cancelled", reason: "cancelled_by_user" });
  });

  test("cancelCurrentRun terminally cancels a needs_user run and its durable job", async () => {
    const fixture = await createFixture(1_000);
    const loop = await fixture.manager.create("project-a", manualConfig);
    const { job } = await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: `manual:${loop.loopId}`,
    });
    const claimed = (await fixture.coordinator.dispatchReady())[0]!;
    const hitlId = crypto.randomUUID();
    const blocked = {
      runId: "run-needs-user-cancel",
      loopId: loop.loopId,
      status: "needs_user" as const,
      trigger: "manual" as const,
      startedAt: 900,
      endedAt: 950,
      jobId: job.jobId,
      sessionId: "session-needs-user-cancel",
      blockedReason: "needs_user",
      blockedByHitlIds: [hitlId],
      attentionStatus: "waiting_for_human" as const,
      resumeCheckpoint: {
        version: 1 as const,
        hitlId,
        loopId: loop.loopId,
        runId: "run-needs-user-cancel",
        jobId: job.jobId,
        trigger: "manual" as const,
        intendedContinuation: "resume_run" as const,
      },
    };
    await fixture.manager.recordRunBlocked(loop.loopId, blocked);
    await fixture.coordinator.finish(claimed.jobId, {
      leaseOwnerId: claimed.leaseOwnerId!,
      leaseToken: claimed.leaseToken!,
    }, {
      status: "needs_user",
      blockedReason: "needs_user",
      blockedByHitlIds: [hitlId],
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: blocked.resumeCheckpoint,
    });

    const report = await fixture.scheduler.cancelCurrentRun(loop.loopId);

    expect(report).toMatchObject({
      runId: blocked.runId,
      jobId: job.jobId,
      status: "cancelled",
      reason: "cancelled_by_user",
    });
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({
      status: "cancelled",
      attentionStatus: "clear",
    });
    const cancelledJob = await fixture.jobQueue.read(job.jobId);
    expect(cancelledJob.blockedByHitlIds).toBeUndefined();
    expect(cancelledJob.resumeCheckpoint).toBeUndefined();
    const state = await fixture.manager.read(loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun).toMatchObject({ runId: blocked.runId, status: "cancelled" });
    expect(state.blockedByHitlIds).toBeUndefined();
    expect(state.resumeCheckpoint).toBeUndefined();
    expect(state.attentionStatus).toBe("clear");
    expect(state.runCount).toBe(1);
    expect((await fixture.manager.readRunLog(loop.loopId, 1))[0]).toMatchObject({
      runId: blocked.runId,
      status: "cancelled",
      reason: "cancelled_by_user",
    });
  });

  test("cancelCurrentRun waits for an in-flight Session HITL continuation to stop before committing terminal state", async () => {
    const fixture = await createFixture(1_000);
    const loop = await fixture.manager.create("project-a", manualConfig);
    const { job } = await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: `manual:${loop.loopId}`,
    });
    const claimed = (await fixture.coordinator.dispatchReady())[0]!;
    const hitlId = crypto.randomUUID();
    const sessionId = "session-continuing-during-cancel";
    const blocked = {
      runId: "run-continuing-during-cancel",
      loopId: loop.loopId,
      status: "needs_user" as const,
      trigger: "manual" as const,
      startedAt: 900,
      endedAt: 950,
      jobId: job.jobId,
      sessionId,
      blockedReason: "needs_user",
      blockedByHitlIds: [hitlId],
      attentionStatus: "waiting_for_human" as const,
      resumeCheckpoint: {
        version: 1 as const,
        hitlId,
        loopId: loop.loopId,
        runId: "run-continuing-during-cancel",
        jobId: job.jobId,
        trigger: "manual" as const,
        intendedContinuation: "resume_run" as const,
      },
    };
    await fixture.manager.recordRunBlocked(loop.loopId, blocked);
    await fixture.coordinator.finish(claimed.jobId, {
      leaseOwnerId: claimed.leaseOwnerId!,
      leaseToken: claimed.leaseToken!,
    }, {
      status: "needs_user",
      blockedReason: "needs_user",
      blockedByHitlIds: [hitlId],
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: blocked.resumeCheckpoint,
    });
    const continuation = new LoopSessionHitlContinuationCoordinator({
      stateManager: fixture.manager,
      jobQueue: fixture.jobQueue,
      jobCoordinator: fixture.coordinator,
      collisionLedger: fixture.collisionLedger,
      now: () => fixture.clock.now(),
      scheduleCleanup: () => undefined,
    });
    const continuationLease = await continuation.acquire({
      origin: {
        kind: "loop",
        loopId: loop.loopId,
        runId: blocked.runId,
        trigger: "manual",
        approvalPolicy: "interactive",
      },
      sessionId,
      rootSessionId: sessionId,
      hitlId,
    });
    const stopEntered = createDeferred<void>();
    const releaseStop = createDeferred<void>();
    const scheduler = new LoopScheduler({
      stateManager: fixture.manager,
      clock: fixture.clock,
      timer: fixture.timer,
      cronAdapter: fixture.cron,
      jobQueue: fixture.jobQueue,
      coordinator: fixture.coordinator,
      budgetLedger: fixture.budgetLedger,
      collisionLedger: fixture.collisionLedger,
      killStateManager: fixture.killStateManager,
      stopSessionFamily: async (requestedSessionId) => {
        expect(requestedSessionId).toBe(sessionId);
        stopEntered.resolve();
        await releaseStop.promise;
        await continuationLease.fail(new Error("Session family stopped"));
      },
      hitl: createLoopTestHitlService(TMP_DIR, fixture.manager),
      runner: async () => ({ status: "succeeded", summary: "must not run" }),
      cleanupJob: async () => undefined,
      readSessionAttempt: async () => ({}),
    });

    const cancellation = scheduler.cancelCurrentRun(loop.loopId);
    await stopEntered.promise;
    await Bun.sleep(5);

    expect((await fixture.manager.read(loop.loopId)).currentRun).toMatchObject({
      runId: blocked.runId,
      status: "running",
    });
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({ status: "running" });

    releaseStop.resolve();
    const report = await cancellation;

    expect(report).toMatchObject({
      runId: blocked.runId,
      status: "cancelled",
      reason: "cancelled_by_user",
    });
    const state = await fixture.manager.read(loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun).toMatchObject({ runId: blocked.runId, status: "cancelled" });
    expect(state.blockedByHitlIds).toBeUndefined();
    expect(state.resumeCheckpoint).toBeUndefined();
    expect(state.attentionStatus).toBe("clear");
    const cancelledJob = await fixture.jobQueue.read(job.jobId);
    expect(cancelledJob).toMatchObject({ status: "cancelled", attentionStatus: "clear" });
    expect(cancelledJob.blockedByHitlIds).toBeUndefined();
    expect(cancelledJob.resumeCheckpoint).toBeUndefined();
    expect((await fixture.manager.readRunLog(loop.loopId, 1))[0]).toMatchObject({
      runId: blocked.runId,
      status: "cancelled",
      reason: "cancelled_by_user",
    });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("cancelCurrentRun is a no-op when the run already finished", async () => {
    const fixture = await createFixture(1_000);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.manager.recordRunStart(loop.loopId, {
      runId: "run-finished",
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: 900,
      sessionId: "session-finished",
    });
    await fixture.manager.recordRunFinish(loop.loopId, {
      runId: "run-finished",
      loopId: loop.loopId,
      status: "succeeded",
      trigger: "manual",
      startedAt: 900,
      endedAt: 950,
      sessionId: "session-finished",
    });

    const report = await fixture.scheduler.cancelCurrentRun(loop.loopId);

    expect(report).toBeUndefined();
    fixture.executionManager.assertCallCount("stopSessionFamily", 0);
    expect((await fixture.manager.read(loop.loopId)).lastRun).toMatchObject({ status: "succeeded" });
  });

  test("global kill persists, cancels active runs, and blocks manual and interval triggers until cleared", async () => {
    const fixture = await createFixture(0);
    const loop = await fixture.manager.create("project-a", intervalConfig);
    const paused = await fixture.manager.create("project-a", intervalConfig);
    await fixture.scheduler.pause(paused.loopId);
    await fixture.manager.recordRunStart(loop.loopId, {
      runId: "run-global-kill",
      loopId: loop.loopId,
      status: "running",
      trigger: "interval",
      startedAt: 0,
      sessionId: "session-global-kill",
    });

    const state = await fixture.scheduler.activateGlobalKill({ activatedBy: "architect", reason: "stop automation" });

    expect(state).toMatchObject({ globalKillActive: true, activatedAt: 0, activatedBy: "architect", reason: "stop automation" });
    fixture.executionManager.assertCallCount("stopSessionFamily", 1);
    expect((await fixture.manager.read(loop.loopId)).lastRun).toMatchObject({ status: "cancelled", reason: "global_kill_active" });
    expect(await new LoopKillStateManager(TMP_DIR).read()).toEqual(state);

    await fixture.manager.update(loop.loopId, { nextRunAt: 100 });
    await fixture.scheduler.scheduleLoop(loop.loopId);
    expect(fixture.timer.size()).toBe(0);

    const manualBlocked = await fixture.scheduler.runManual(loop.loopId);
    await fixture.scheduler.clearGlobalKill();
    await fixture.scheduler.scheduleLoop(loop.loopId);
    expect(fixture.timer.nextDue()).toBe(100);
    await fixture.scheduler.activateGlobalKill({ reason: "block due timer" });
    await fixture.timer.advanceTo(100);

    expect(manualBlocked).toMatchObject({ status: "skipped", trigger: "manual", reason: "global_kill_active" });
    const blockedReports = await fixture.manager.readRunLog(loop.loopId);
    expect(blockedReports.filter((report) => report.status === "skipped" && report.reason === "global_kill_active").map((report) => report.trigger).sort()).toEqual(["interval", "manual"]);
    expect(fixture.runs).toEqual([]);

    fixture.clock.set(150);
    const cleared = await fixture.scheduler.clearGlobalKill();
    expect(cleared).toEqual({ globalKillActive: false });
    expect((await fixture.manager.read(paused.loopId)).status).toBe("paused");

    const accepted = await fixture.scheduler.runManual(loop.loopId);
    expect(accepted).toMatchObject({ status: "succeeded", trigger: "manual" });
    expect(fixture.runs).toHaveLength(1);
  });

  test("manual trigger blocked by global kill records global_kill_active without starting runner", async () => {
    const fixture = await createFixture(0);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.scheduler.activateGlobalKill({ reason: "stop all loops" });

    const report = await fixture.scheduler.runManual(loop.loopId);

    expect(report).toMatchObject({ status: "skipped", trigger: "manual", reason: "global_kill_active" });
    expect(fixture.runs).toEqual([]);
    expect((await fixture.manager.readRunLog(loop.loopId, 1))[0]).toMatchObject({ status: "skipped", reason: "global_kill_active" });
  });

  test("interval trigger with exhausted daily budget records skipped budget reason without starting runner", async () => {
    const fixture = await createFixture(Date.UTC(2026, 6, 4, 10, 0, 0));
    const loop = await fixture.manager.create("project-a", {
      ...intervalConfig,
      limits: { ...intervalConfig.limits, maxRunsPerDay: 1, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
    });
    await fixture.budgetLedger.recordRunStart(loop.loopId, "run-already-used");
    await fixture.manager.update(loop.loopId, { nextRunAt: fixture.clock.now() + 100 });

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(fixture.clock.now() + 100);

    expect(fixture.runs).toEqual([]);
    const latest = (await fixture.manager.readRunLog(loop.loopId, 1))[0];
    expect(latest).toMatchObject({ status: "skipped", trigger: "interval", reason: "hard_budget_exceeded" });
    expect(latest?.skippedReason).toMatch(/budget/i);
    expect((await fixture.manager.read(loop.loopId)).status).toBe("paused");
  });

  test("static collision leases release after scheduled run success", async () => {
    const fixture = await createFixture(100);
    const loop = await fixture.manager.create("project-a", {
      ...intervalConfig,
      collisionTargets: [{ type: "file", path: "src/scheduled.ts" }],
    });
    await fixture.manager.update(loop.loopId, { nextRunAt: 200 });

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(200);

    expect(fixture.runs).toHaveLength(1);
    expect((await fixture.manager.read(loop.loopId)).lastRun).toMatchObject({ status: "succeeded", collisionTargets: [{ type: "file", path: "src/scheduled.ts" }] });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("static collision leases release after scheduled runner throws", async () => {
    const fixture = await createFixture(100);
    const loop = await fixture.manager.create("project-a", {
      ...intervalConfig,
      collisionTargets: [{ type: "file", path: "src/throws.ts" }],
    });
    await fixture.manager.update(loop.loopId, { nextRunAt: 200 });
    fixture.runner = async () => {
      throw new Error("runner failed");
    };

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(200);

    expect((await fixture.manager.read(loop.loopId)).lastRun).toMatchObject({ status: "failed", error: "runner failed" });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("static collision leases release after cancel and global-kill cancel", async () => {
    const fixture = await createFixture(100);
    const userCancelled = await fixture.manager.create("project-a", {
      ...manualConfig,
      collisionTargets: [{ type: "file", path: "src/user-cancel.ts" }],
    });
    const globalKilled = await fixture.manager.create("project-a", {
      ...manualConfig,
      title: "Global killed loop",
      collisionTargets: [{ type: "file", path: "src/global-kill.ts" }],
    });
    const deferred = createDeferred<void>();
    const runnerStarted = createDeferred<void>();
    fixture.runner = async () => {
      runnerStarted.resolve();
      await deferred.promise;
      return { status: "succeeded", summary: "late" };
    };

    const activeRun = fixture.scheduler.runManual(userCancelled.loopId);
    await runnerStarted.promise;
    expect(await fixture.collisionLedger.readActiveLeases()).toHaveLength(1);
    await fixture.scheduler.cancelCurrentRun(userCancelled.loopId);
    deferred.resolve();
    await activeRun;
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);

    const globalRunStarted = createDeferred<void>();
    const globalDeferred = createDeferred<void>();
    fixture.runner = async () => {
      globalRunStarted.resolve();
      await globalDeferred.promise;
      return { status: "succeeded", summary: "late global" };
    };
    const globalRun = fixture.scheduler.runManual(globalKilled.loopId);
    await globalRunStarted.promise;
    expect(await fixture.collisionLedger.readActiveLeases()).toHaveLength(1);
    await fixture.scheduler.activateGlobalKill({ reason: "stop" });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
    globalDeferred.resolve();
    await globalRun;
  });

  test("static collision leases release after hard budget abort records terminal report", async () => {
    const fixture = await createFixture(100);
    const loop = await fixture.manager.create("project-a", {
      ...manualConfig,
      collisionTargets: [{ type: "file", path: "src/hard-budget.ts" }],
    });
    fixture.runner = async (input) => {
      await fixture.budgetLedger.recordHardExceeded({
        loopId: input.loop.loopId,
        runId: input.runId,
        source: "test",
        summary: "hard stop",
      });
      return { status: "budget_exceeded", reason: "hard_budget_exceeded", summary: "hard stop" };
    };

    const report = await fixture.scheduler.runManual(loop.loopId);

    expect(report).toMatchObject({ status: "budget_exceeded", reason: "hard_budget_exceeded" });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("stop clears timers and prevents new runs", async () => {
    const fixture = await createFixture();
    const loop = await fixture.manager.create("project-a", intervalConfig);
    await fixture.manager.update(loop.loopId, { nextRunAt: 100 });

    await fixture.scheduler.start("project-a");
    expect(fixture.timer.size()).toBe(1);

    await fixture.scheduler.stop();
    expect(fixture.timer.size()).toBe(0);

    await fixture.timer.advanceTo(100);
    await fixture.scheduler.runManual(loop.loopId);

    expect(fixture.runs).toEqual([]);
  });

  test("startup cancels stale currentRun that has no durable running job", async () => {
    const fixture = await createFixture(1_000);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.manager.recordRunStart(loop.loopId, {
      runId: "stale-run",
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: 500,
      sessionId: "stale-session",
    });

    await fixture.scheduler.start("project-a");
    const report = await fixture.scheduler.runManual(loop.loopId);

    const reports = await fixture.manager.readRunLog(loop.loopId);
    expect(reports[1]).toMatchObject({ runId: "stale-run", status: "cancelled", summary: "Recovered stale running loop state on scheduler startup." });
    expect(report).toMatchObject({ status: "succeeded", trigger: "manual" });
    expect(fixture.runs).toHaveLength(1);
  });

  test("startup promotes a write-ahead terminal report instead of rerunning its Session", async () => {
    const fixture = await createFixture(1_000);
    const loop = await fixture.manager.create("project-a", manualConfig);
    const queued = await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: "manual:saga-report-first",
      worktreePath: "/tmp/saga-report-first",
      worktreeBranchName: "archcode/loop/test/saga-report-first",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "a".repeat(40),
    });
    const running = (await fixture.coordinator.dispatchReady())[0]!;
    const report = {
      runId: "saga-report-first-run",
      loopId: loop.loopId,
      status: "succeeded" as const,
      trigger: "manual" as const,
      startedAt: 1_000,
      endedAt: 1_010,
      jobId: queued.job.jobId,
      worktreePath: running.worktreePath,
      worktreeBranchName: running.worktreeBranchName,
      baseSha: running.baseSha,
      resolvedHeadSha: running.resolvedHeadSha,
      cleanupState: "in_progress" as const,
    };
    await fixture.manager.recordRunStart(loop.loopId, { ...report, status: "running", endedAt: undefined });
    // Simulate a crash after the terminal JSONL write-ahead record but before
    // recordRunFinish can commit lastRun/runCount/currentRun.
    await fixture.manager.appendRunReport(loop.loopId, report);
    const cleanupJob = mock(async (jobId: string) => {
      const current = await fixture.jobQueue.read(jobId);
      await fixture.jobQueue.updateIfCurrent(jobId, current, { cleanupState: "cleaned" });
      return {
        jobId,
        worktreePath: current.worktreePath!,
        cleanupState: "cleaned" as const,
        removed: true,
        reviewRequired: false,
        reason: "recovered cleanup",
      };
    });

    await fixture.createScheduler(undefined, fixture.coordinator, cleanupJob).start("project-a");

    expect(fixture.runs).toEqual([]);
    expect(cleanupJob).toHaveBeenCalledTimes(1);
    expect(await fixture.jobQueue.read(running.jobId)).toMatchObject({ status: "succeeded", cleanupState: "cleaned" });
    const recovered = await fixture.manager.read(loop.loopId);
    expect(recovered.currentRun).toBeUndefined();
    expect(recovered).toMatchObject({
      runCount: 1,
      lastRun: { runId: report.runId, status: "succeeded", cleanupState: "cleaned" },
    });
  });

  test("startup reconciles a terminal cancelled run whose job was still needs_user", async () => {
    const fixture = await createFixture(1_250);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: "manual:cancelled-needs-user-crash",
    });
    const claimed = (await fixture.coordinator.dispatchReady())[0]!;
    const hitlId = crypto.randomUUID();
    const blocked = {
      runId: "cancelled-needs-user-crash-run",
      loopId: loop.loopId,
      status: "needs_user" as const,
      trigger: "manual" as const,
      startedAt: 1_200,
      endedAt: 1_225,
      jobId: claimed.jobId,
      blockedReason: "needs_user",
      blockedByHitlIds: [hitlId],
      attentionStatus: "waiting_for_human" as const,
      resumeCheckpoint: {
        version: 1 as const,
        hitlId,
        loopId: loop.loopId,
        runId: "cancelled-needs-user-crash-run",
        jobId: claimed.jobId,
        trigger: "manual" as const,
        intendedContinuation: "resume_run" as const,
      },
    };
    await fixture.manager.recordRunBlocked(loop.loopId, blocked);
    await fixture.coordinator.finish(claimed.jobId, executionLease(claimed), {
      status: "needs_user",
      blockedReason: "needs_user",
      blockedByHitlIds: [hitlId],
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: blocked.resumeCheckpoint,
    });
    // Simulate a crash after the cancellation report/state commit and before
    // the corresponding non-terminal queue record can be finalized.
    await fixture.manager.recordRunFinish(loop.loopId, {
      ...blocked,
      status: "cancelled",
      endedAt: 1_250,
      reason: "cancelled_by_user",
      blockedReason: "cancelled_by_user",
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
      resumeCheckpoint: undefined,
    });
    expect((await fixture.jobQueue.read(claimed.jobId)).status).toBe("needs_user");

    await fixture.createScheduler().start("project-a");

    expect(fixture.runs).toEqual([]);
    expect(await fixture.jobQueue.read(claimed.jobId)).toMatchObject({
      status: "cancelled",
      blockedReason: "cancelled_by_user",
      attentionStatus: "clear",
    });
    const recovered = await fixture.manager.read(loop.loopId);
    expect(recovered.currentRun).toBeUndefined();
    expect(recovered).toMatchObject({
      runCount: 1,
      lastRun: { runId: blocked.runId, status: "cancelled", reason: "cancelled_by_user" },
      attentionStatus: "clear",
    });
  });

  test("startup converges same-status Goal HITL job fields from authoritative run report", async () => {
    const fixture = await createFixture(1_450);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.jobQueue.enqueue({ loopId: loop.loopId, triggerKind: "manual", subjectKey: "manual:hitl-convergence" });
    const running = (await fixture.coordinator.dispatchReady())[0]!;
    const oldHitlId = crypto.randomUUID();
    const nextHitlId = crypto.randomUUID();
    const runId = "goal-hitl-convergence-run";
    const sessionId = "goal-hitl-main";
    const base = {
      runId,
      loopId: loop.loopId,
      status: "running" as const,
      trigger: "manual" as const,
      startedAt: 1_450,
      jobId: running.jobId,
      goalId: "goal-hitl-convergence",
      sessionId,
    };
    await fixture.manager.recordRunStart(loop.loopId, base);
    await fixture.coordinator.checkpointSessionAttempt(running.jobId, executionLease(running), {
      runId,
      sessionId,
      sessionExecutionId: "goal-hitl-execution",
    });
    const oldCheckpoint = recoveredCheckpoint(base, running.jobId, oldHitlId);
    await fixture.coordinator.finish(running.jobId, executionLease(running), {
      status: "needs_user",
      blockedReason: "needs_user",
      blockedByHitlIds: [oldHitlId, nextHitlId],
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: oldCheckpoint,
    });
    const nextCheckpoint = recoveredCheckpoint(base, running.jobId, nextHitlId);
    await fixture.manager.recordRunBlocked(loop.loopId, {
      ...base,
      status: "needs_user",
      endedAt: 1_451,
      blockedReason: "needs_user",
      blockedByHitlIds: [nextHitlId],
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: nextCheckpoint,
    });

    await fixture.createScheduler().start("project-a");

    expect(await fixture.jobQueue.read(running.jobId)).toMatchObject({
      status: "needs_user",
      blockedByHitlIds: [nextHitlId],
      resumeCheckpoint: { hitlId: nextHitlId },
    });
  });

  test("startup promotes a durable completed Session attempt before terminal JSONL without replay", async () => {
    const fixture = await createFixture(1_500);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.jobQueue.enqueue({ loopId: loop.loopId, triggerKind: "manual", subjectKey: "manual:session-attempt" });
    const running = (await fixture.coordinator.dispatchReady())[0]!;
    const runId = "durable-session-attempt-run";
    const sessionId = "durable-session-attempt";
    const executionId = "durable-session-execution";
    await fixture.manager.recordRunStart(loop.loopId, {
      runId,
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: 1_500,
      jobId: running.jobId,
      sessionId,
    });
    await fixture.coordinator.checkpointSessionAttempt(running.jobId, executionLease(running), {
      runId,
      sessionId,
      sessionExecutionId: executionId,
    });

    const scheduler = fixture.createScheduler(undefined, fixture.coordinator, undefined, async () => ({
      execution: { id: executionId, startedAt: 1_500, endedAt: 1_510, status: "completed" },
    }));
    await scheduler.start("project-a");

    expect(fixture.runs).toEqual([]);
    expect(await fixture.jobQueue.read(running.jobId)).toMatchObject({ status: "succeeded", sessionId, sessionExecutionId: executionId });
    const recoveredState = await fixture.manager.read(loop.loopId);
    expect(recoveredState).toMatchObject({
      runCount: 1,
      lastRun: { runId, status: "succeeded", sessionId },
    });
    expect(recoveredState.currentRun).toBeUndefined();
  });

  test("startup preserves a completed non-terminal Goal turn for same-run continuation", async () => {
    const fixture = await createFixture(1_550);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.jobQueue.enqueue({ loopId: loop.loopId, triggerKind: "manual", subjectKey: "manual:goal-attempt" });
    const running = (await fixture.coordinator.dispatchReady())[0]!;
    const runId = "durable-goal-attempt-run";
    const sessionId = "durable-goal-main";
    const executionId = "durable-goal-execution";
    await fixture.manager.recordRunStart(loop.loopId, {
      runId,
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: 1_550,
      jobId: running.jobId,
      sessionId,
      goalId: "durable-goal",
    });
    await fixture.coordinator.checkpointSessionAttempt(running.jobId, executionLease(running), {
      runId,
      sessionId,
      sessionExecutionId: executionId,
    });

    const restartedCoordinator = new LoopJobCoordinator({
      queue: fixture.jobQueue,
      clock: fixture.clock,
      leaseTtlMs: 60_000,
      incarnationId: "restarted-goal-continuation",
    });
    let continuationAttempts = 0;
    const continueGoalRun = mock(async (_input: ContinueLoopGoalRunInput) => {
      continuationAttempts += 1;
      if (continuationAttempts === 1) {
        throw new LoopGoalTurnContinuationPendingError("durable-goal", sessionId, runId, 1_000);
      }
      return {
        status: "succeeded" as const,
        goalId: "durable-goal",
        sessionId,
        summary: "Recovered Goal completed",
      };
    });
    const scheduler = fixture.createScheduler(undefined, restartedCoordinator, undefined, async () => ({
      execution: { id: executionId, startedAt: 1_550, endedAt: 1_560, status: "completed" },
    }), continueGoalRun);
    await scheduler.start("project-a");

    expect(fixture.runs).toEqual([]);
    expect(await fixture.jobQueue.read(running.jobId)).toMatchObject({ status: "pending", runId, sessionId });
    expect(continueGoalRun).toHaveBeenCalledTimes(1);

    await fixture.timer.advanceTo(2_550);

    expect(await fixture.jobQueue.read(running.jobId)).toMatchObject({
      status: "succeeded",
      runId,
      sessionId,
    });
    expect(continueGoalRun).toHaveBeenCalledTimes(2);
    expect(continueGoalRun.mock.calls[1]?.[0]).toMatchObject({
      run: { runId, goalId: "durable-goal", sessionId },
      job: { jobId: running.jobId, runId, sessionId },
    });
    const recoveredState = await fixture.manager.read(loop.loopId);
    expect(recoveredState.currentRun).toBeUndefined();
    expect(recoveredState.lastRun).toMatchObject({ runId, status: "succeeded", goalId: "durable-goal" });
  });

  test("startup reconciles committed Goal state before dispatching Goal continuations", async () => {
    const fixture = await createFixture(1_600);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.manager.recordRunStart(loop.loopId, {
      runId: "goal-state-recovery-run",
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: 1_500,
      goalId: "goal-state-recovery",
      sessionId: "goal-state-recovery-session",
    });
    const reconcileGoalState = mock(async () => undefined);

    await fixture.createScheduler(undefined, undefined, undefined, undefined, undefined, reconcileGoalState).start("project-a");

    expect(reconcileGoalState).toHaveBeenCalledWith("goal-state-recovery");
  });

  test("renews Goal continuation collisions through the remaining run budget and releases them on HITL", async () => {
    const MINUTE_MS = 60_000;
    const fixture = await createFixture(0);
    const collisionTarget = { type: "file" as const, path: "src/goal-continuation.ts" };
    const loop = await fixture.manager.create("project-a", {
      ...manualConfig,
      limits: {
        ...manualConfig.limits,
        maxWallClockMsPerRun: 45 * MINUTE_MS,
      },
      collisionTargets: [collisionTarget],
    });
    const competingLoop = await fixture.manager.create("project-a", {
      ...manualConfig,
      title: "Competing loop",
      collisionTargets: [collisionTarget],
    });
    await fixture.jobQueue.enqueue({ loopId: loop.loopId, triggerKind: "manual", subjectKey: "manual:long-goal" });
    const running = (await fixture.coordinator.dispatchReady())[0]!;
    const runId = "long-goal-run";
    const sessionId = "long-goal-main";
    const executionId = "long-goal-execution";
    await fixture.manager.recordRunStart(loop.loopId, {
      runId,
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: 0,
      jobId: running.jobId,
      sessionId,
      goalId: "long-goal",
      collisionTargets: [collisionTarget],
    });
    await fixture.coordinator.checkpointSessionAttempt(running.jobId, executionLease(running), {
      runId,
      sessionId,
      sessionExecutionId: executionId,
    });
    await fixture.collisionLedger.acquire({
      target: collisionTarget,
      loopId: loop.loopId,
      runId,
      priority: running.priority,
    });
    fixture.clock.set(31 * MINUTE_MS);

    const restartedCoordinator = new LoopJobCoordinator({
      queue: fixture.jobQueue,
      clock: fixture.clock,
      leaseTtlMs: 60_000,
      incarnationId: "long-goal-restart",
    });
    const continueGoalRun = mock(async () => {
      const renewed = (await fixture.collisionLedger.readActiveLeases()).find((lease) => (
        lease.loopId === loop.loopId && lease.runId === runId
      ));
      expect(renewed?.expiresAt).toBe(50 * MINUTE_MS);
      const conflict = await fixture.collisionLedger.acquire({
        target: collisionTarget,
        loopId: competingLoop.loopId,
        runId: "competing-run",
        priority: 0,
      });
      expect(conflict.acquired).toBe(false);
      return {
        status: "succeeded" as const,
        blockedReason: "needs_user" as const,
        blockedByHitlIds: ["goal-hitl-1"],
        resumeCheckpoint: {
          version: 1 as const,
          hitlId: "goal-hitl-1",
          loopId: loop.loopId,
          runId,
          jobId: running.jobId,
          trigger: "manual" as const,
          intendedContinuation: "resume_run" as const,
        },
        goalId: "long-goal",
        sessionId,
      };
    });
    const scheduler = fixture.createScheduler(undefined, restartedCoordinator, undefined, async () => ({
      execution: { id: executionId, startedAt: 0, endedAt: 1, status: "completed" },
    }), continueGoalRun);

    await scheduler.start("project-a");

    expect(continueGoalRun).toHaveBeenCalledTimes(1);
    expect((await fixture.manager.read(loop.loopId)).currentRun).toMatchObject({ status: "needs_user", runId });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
    const acquiredAfterHitl = await fixture.collisionLedger.acquire({
      target: collisionTarget,
      loopId: competingLoop.loopId,
      runId: "competing-run-after-hitl",
      priority: 0,
    });
    expect(acquiredAfterHitl.acquired).toBe(true);
  });

  test("startup projects a non-worktree terminal JSONL before cancelling stale currentRun", async () => {
    const fixture = await createFixture(1_600);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.jobQueue.enqueue({ loopId: loop.loopId, triggerKind: "manual", subjectKey: "manual:no-cleanup-projection" });
    const running = (await fixture.coordinator.dispatchReady())[0]!;
    const report = {
      runId: "no-cleanup-projection-run",
      loopId: loop.loopId,
      status: "succeeded" as const,
      trigger: "manual" as const,
      startedAt: 1_600,
      endedAt: 1_610,
      jobId: running.jobId,
    };
    await fixture.manager.recordRunStart(loop.loopId, { ...report, status: "running", endedAt: undefined });
    await fixture.manager.appendRunReport(loop.loopId, report);

    await fixture.createScheduler().start("project-a");

    expect(fixture.runs).toEqual([]);
    expect(await fixture.jobQueue.read(running.jobId)).toMatchObject({ status: "succeeded" });
    const recoveredState = await fixture.manager.read(loop.loopId);
    expect(recoveredState).toMatchObject({ runCount: 1, lastRun: { status: "succeeded" } });
    expect(recoveredState.currentRun).toBeUndefined();
    expect((await fixture.manager.readRunLog(loop.loopId, 1))[0]).toMatchObject({ status: "succeeded" });
  });

  test("startup resumes a terminal queue cleanup intent without rerunning execution", async () => {
    const fixture = await createFixture(2_000);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: "manual:saga-intent",
      worktreePath: "/tmp/saga-intent",
      worktreeBranchName: "archcode/loop/test/saga-intent",
      baseSha: "b".repeat(40),
      resolvedHeadSha: "b".repeat(40),
    });
    const running = (await fixture.coordinator.dispatchReady())[0]!;
    const report = {
      runId: "saga-intent-run",
      loopId: loop.loopId,
      status: "succeeded" as const,
      trigger: "manual" as const,
      startedAt: 2_000,
      endedAt: 2_010,
      jobId: running.jobId,
      worktreePath: running.worktreePath,
      worktreeBranchName: running.worktreeBranchName,
      baseSha: running.baseSha,
      resolvedHeadSha: running.resolvedHeadSha,
      cleanupState: "in_progress" as const,
    };
    await fixture.manager.recordRunStart(loop.loopId, { ...report, status: "running", endedAt: undefined });
    await fixture.manager.recordRunFinish(loop.loopId, report);
    await fixture.coordinator.finish(running.jobId, executionLease(running), {
      status: "succeeded",
      cleanupState: "in_progress",
    });
    const cleanupJob = mock(async (jobId: string) => {
      const current = await fixture.jobQueue.read(jobId);
      await fixture.jobQueue.updateIfCurrent(jobId, current, { cleanupState: "preserved" });
      return {
        jobId,
        worktreePath: current.worktreePath!,
        cleanupState: "preserved" as const,
        removed: false,
        reviewRequired: false,
        reason: "policy preserved",
      };
    });

    await fixture.createScheduler(undefined, fixture.coordinator, cleanupJob).start("project-a");

    expect(fixture.runs).toEqual([]);
    expect(cleanupJob).toHaveBeenCalledTimes(1);
    expect(await fixture.jobQueue.read(running.jobId)).toMatchObject({ status: "succeeded", cleanupState: "preserved" });
    expect((await fixture.manager.read(loop.loopId)).lastRun).toMatchObject({ cleanupState: "preserved" });
  });

  test("startup repairs a cleanup-complete queue whose report update was interrupted", async () => {
    const fixture = await createFixture(3_000);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: "manual:saga-completion",
      worktreePath: "/tmp/saga-completion",
      worktreeBranchName: "archcode/loop/test/saga-completion",
      baseSha: "c".repeat(40),
      resolvedHeadSha: "c".repeat(40),
    });
    const running = (await fixture.coordinator.dispatchReady())[0]!;
    const report = {
      runId: "saga-completion-run",
      loopId: loop.loopId,
      status: "succeeded" as const,
      trigger: "manual" as const,
      startedAt: 3_000,
      endedAt: 3_010,
      jobId: running.jobId,
      worktreePath: running.worktreePath,
      worktreeBranchName: running.worktreeBranchName,
      baseSha: running.baseSha,
      resolvedHeadSha: running.resolvedHeadSha,
      cleanupState: "in_progress" as const,
    };
    await fixture.manager.recordRunStart(loop.loopId, { ...report, status: "running", endedAt: undefined });
    await fixture.manager.recordRunFinish(loop.loopId, report);
    const terminal = await fixture.coordinator.finish(running.jobId, executionLease(running), {
      status: "succeeded",
      cleanupState: "in_progress",
    });
    await fixture.jobQueue.updateIfCurrent(terminal.jobId, terminal, {
      cleanupState: "cleaned",
      cleanupWarning: "orphan branch retained",
    });
    const cleanupJob = mock(async () => undefined);

    await fixture.createScheduler(undefined, fixture.coordinator, cleanupJob).start("project-a");

    expect(fixture.runs).toEqual([]);
    expect(cleanupJob).not.toHaveBeenCalled();
    expect((await fixture.manager.read(loop.loopId)).lastRun).toMatchObject({
      cleanupState: "cleaned",
      cleanupWarning: "orphan branch retained",
    });
  });

  test("startup repairs Loop state when cleanup JSONL committed before its state projection", async () => {
    const fixture = await createFixture(4_000);
    const loop = await fixture.manager.create("project-a", manualConfig);
    await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: "manual:saga-state-projection",
      worktreePath: "/tmp/saga-state-projection",
      worktreeBranchName: "archcode/loop/test/saga-state-projection",
      baseSha: "d".repeat(40),
      resolvedHeadSha: "d".repeat(40),
    });
    const running = (await fixture.coordinator.dispatchReady())[0]!;
    const report = {
      runId: "saga-state-projection-run",
      loopId: loop.loopId,
      status: "succeeded" as const,
      trigger: "manual" as const,
      startedAt: 4_000,
      endedAt: 4_010,
      jobId: running.jobId,
      worktreePath: running.worktreePath,
      worktreeBranchName: running.worktreeBranchName,
      baseSha: running.baseSha,
      resolvedHeadSha: running.resolvedHeadSha,
      cleanupState: "cleaned" as const,
      observedArtifacts: [{ path: "cleanup:cleaned", status: "observed" as const }],
    };
    await fixture.manager.recordRunStart(loop.loopId, { ...report, status: "running", endedAt: undefined, cleanupState: "in_progress" });
    await fixture.manager.appendRunReport(loop.loopId, report);
    await fixture.coordinator.finish(running.jobId, executionLease(running), {
      status: "succeeded",
      cleanupState: "cleaned",
      observedArtifacts: report.observedArtifacts,
    });
    const cleanupJob = mock(async () => undefined);

    await fixture.createScheduler(undefined, fixture.coordinator, cleanupJob).start("project-a");

    expect(fixture.runs).toEqual([]);
    expect(cleanupJob).not.toHaveBeenCalled();
    const recovered = await fixture.manager.read(loop.loopId);
    expect(recovered.currentRun).toBeUndefined();
    expect(recovered).toMatchObject({
      runCount: 1,
      cleanupState: "cleaned",
      lastRun: { runId: report.runId, status: "succeeded", cleanupState: "cleaned" },
    });
  });

  test("trigger polling cancels jobs if global kill activates during poll", async () => {
    const fixture = await createFixture(0, { localHead: { repoId: "test-owner/test-repo", branch: "main", sha: "before" } });
    await fixture.manager.create("project-a", triggerConfig);
    const poller = {
      pollLoopState: async (loop: Awaited<ReturnType<LoopStateManager["read"]>>) => {
        await fixture.jobQueue.enqueue({
          loopId: loop.loopId,
          triggerKind: "on_commit",
          subjectKey: "commit:after",
          eventSummary: { summary: "commit arrived while kill activated" },
          collisionTarget: { type: "branch", owner: "test-owner", repo: "test-repo", branch: "main" },
        });
        await fixture.scheduler.activateGlobalKill({ reason: "stop during poll" });
      },
    } as unknown as LoopTriggerPoller;
    fixture.scheduler = fixture.createScheduler(poller);

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(30_000);

    expect(fixture.runs).toEqual([]);
    expect((await fixture.jobQueue.list())[0]).toMatchObject({ status: "cancelled", blockedReason: "global_kill_active" });
  });

  test("dynamic trigger collision target blocks run before runner starts", async () => {
    const fixture = await createFixture(0, { localHead: { repoId: "test-owner/test-repo", branch: "main", sha: "abc123" } });
    const loop = await fixture.manager.create("project-a", triggerConfig);
    const other = await fixture.manager.create("project-a", manualConfig);
    await fixture.collisionLedger.acquire({
      target: { type: "branch", owner: "test-owner", repo: "test-repo", branch: "main" },
      loopId: other.loopId,
      runId: "other-run",
      priority: 10,
    });

    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(30_000);

    expect(fixture.runs).toEqual([]);
    const report = (await fixture.manager.readRunLog(loop.loopId, 1))[0];
    const job = (await fixture.jobQueue.list())[0]!;
    expect(report).toMatchObject({
      status: "skipped",
      reason: "collision_conflict",
      jobId: job.jobId,
      trigger: "on_commit",
      subjectKey: job.subjectKey,
      dedupeKey: job.dedupeKey,
      baseSha: "abc123",
      collisionTargets: [{ type: "branch", owner: "test-owner", repo: "test-repo", branch: "main" }],
    });
    expect(job).toMatchObject({ status: "skipped", blockedReason: "collision_conflict" });
  });

  test("queued on_commit rerun keeps latest coalesced SHA after stale run report finishes", async () => {
    const oldSha = "1".repeat(40);
    const newSha = "2".repeat(40);
    const fixture = await createFixture(0);
    const loop = await fixture.manager.create("project-a", triggerConfig);
    await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "on_commit",
      subjectKey: "commit:test-owner/test-repo:main",
      repoId: "test-owner/test-repo",
      branch: "main",
      collisionTarget: { type: "branch", owner: "test-owner", repo: "test-repo", branch: "main" },
      baseSha: oldSha,
      eventSummary: { summary: "Observed old commit", payloadSha: oldSha },
    });
    const firstRunnerStarted = createDeferred<void>();
    const finishFirstRunner = createDeferred<void>();
    let runCount = 0;
    fixture.runner = async () => {
      runCount += 1;
      if (runCount === 1) {
        firstRunnerStarted.resolve();
        await finishFirstRunner.promise;
        return { status: "succeeded", summary: "finished original SHA" };
      }
      return { status: "succeeded", summary: "finished rerun SHA" };
    };

    const schedulerStart = fixture.scheduler.start("project-a");
    await firstRunnerStarted.promise;
    await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "on_commit",
      subjectKey: "commit:test-owner/test-repo:main",
      repoId: "test-owner/test-repo",
      branch: "main",
      collisionTarget: { type: "branch", owner: "test-owner", repo: "test-repo", branch: "main" },
      baseSha: newSha,
      eventSummary: { summary: "Observed new commit", payloadSha: newSha },
    });
    expect((await fixture.jobQueue.list(["running"]))[0]).toMatchObject({
      rerunAfterCurrent: true,
      baseSha: oldSha,
      rerunInput: { baseSha: newSha },
    });

    finishFirstRunner.resolve();
    await schedulerStart;

    const jobs = await fixture.jobQueue.list();
    expect(jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded"]);
    expect(jobs[0]).toMatchObject({ baseSha: oldSha });
    expect(jobs[1]).toMatchObject({ triggerKind: "on_commit", baseSha: newSha });
    expect(fixture.runs[1]?.job).toMatchObject({ triggerKind: "on_commit", baseSha: newSha });
  });

  test("schedules cron loops through durable queue before running loop work", async () => {
    const fixture = await createFixture(Date.UTC(2026, 0, 1, 0, 0, 0));
    const loop = await fixture.manager.create("project-a", cronConfig);

    await fixture.scheduler.start("project-a");

    expect(fixture.cron.size()).toBe(1);
    expect((await fixture.manager.read(loop.loopId)).nextScheduledAt).toBe(Date.UTC(2026, 0, 1, 0, 15, 0));

    await fixture.cron.fire(fixture.cron.handles()[0]!, Date.UTC(2026, 0, 1, 0, 15, 0));

    let jobs = await fixture.jobQueue.list();
    let state = await fixture.manager.read(loop.loopId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      loopId: loop.loopId,
      status: "pending",
      triggerKind: "cron",
      subjectKey: `cron:${Date.UTC(2026, 0, 1, 0, 15, 0)}`,
      missedCount: 0,
    });
    expect(fixture.runs).toEqual([]);
    expect(state).toMatchObject({
      lastScheduledAt: Date.UTC(2026, 0, 1, 0, 15, 0),
      lastEnqueuedAt: Date.UTC(2026, 0, 1, 0, 15, 0),
      nextScheduledAt: Date.UTC(2026, 0, 1, 0, 30, 0),
      missedCount: 0,
    });

    await fixture.timer.advanceTo(fixture.clock.now());

    jobs = await fixture.jobQueue.list();
    state = await fixture.manager.read(loop.loopId);
    expect(jobs[0]).toMatchObject({ status: "succeeded", triggerKind: "cron" });
    expect(fixture.runs).toHaveLength(1);
    expect(fixture.runs[0]).toMatchObject({ trigger: "cron" });
    expect(state).toMatchObject({ nextScheduledAt: Date.UTC(2026, 0, 1, 0, 30, 0) });
    expect(state.triggerHealth?.find((entry) => entry.triggerKind === "cron")).toMatchObject({ status: "healthy" });
  });

  test("cron restart catch-up enqueues only the latest missed scheduled time", async () => {
    const fixture = await createFixture(Date.UTC(2026, 0, 1, 1, 1, 0));
    const loop = await fixture.manager.create("project-a", cronConfig);
    await fixture.manager.update(loop.loopId, {
      nextScheduledAt: Date.UTC(2026, 0, 1, 0, 15, 0),
      nextRunAt: Date.UTC(2026, 0, 1, 0, 15, 0),
    });

    await fixture.scheduler.start("project-a");

    const jobs = await fixture.jobQueue.list();
    const state = await fixture.manager.read(loop.loopId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "succeeded",
      triggerKind: "cron",
      subjectKey: `cron:${Date.UTC(2026, 0, 1, 1, 0, 0)}`,
      missedCount: 4,
    });
    expect(state).toMatchObject({
      lastScheduledAt: Date.UTC(2026, 0, 1, 1, 0, 0),
      lastEnqueuedAt: Date.UTC(2026, 0, 1, 1, 0, 0),
      nextScheduledAt: Date.UTC(2026, 0, 1, 1, 15, 0),
      missedCount: 4,
    });
    expect(fixture.runs).toHaveLength(1);
  });

  test("manual, interval, cron, and trigger polling all create durable jobs before runner invocation", async () => {
    const fixture = await createFixture(Date.UTC(2026, 0, 1, 0, 0, 0), {
      localHead: { repoId: "test-owner/test-repo", branch: "main", sha: "abc123" },
    });
    const manual = await fixture.manager.create("project-a", manualConfig);
    const interval = await fixture.manager.create("project-a", {
      ...intervalConfig,
      schedule: { kind: "interval", everyMs: 3_600_000 },
    });
    const cron = await fixture.manager.create("project-a", cronConfig);
    await fixture.manager.create("project-a", triggerConfig);
    await fixture.manager.update(interval.loopId, { nextRunAt: fixture.clock.now() + 100 });
    const durableSeenBeforeRun: string[] = [];
    fixture.runner = async (input) => {
      const running = await fixture.jobQueue.list(["running"]);
      expect(running.some((job) => job.loopId === input.loop.loopId && job.triggerKind === input.trigger)).toBe(true);
      durableSeenBeforeRun.push(input.trigger);
      return { status: "succeeded", summary: "done" };
    };

    await fixture.scheduler.runManual(manual.loopId);
    await fixture.scheduler.start("project-a");
    await fixture.timer.advanceTo(Date.UTC(2026, 0, 1, 0, 0, 0) + 100);
    await fixture.cron.fire(fixture.cron.handles()[0]!, Date.UTC(2026, 0, 1, 0, 15, 0));
    await fixture.timer.advanceTo(fixture.clock.now());
    await fixture.timer.advanceTo(Date.UTC(2026, 0, 1, 0, 15, 30));

    expect(cron.loopId).toBeString();
    expect(durableSeenBeforeRun.sort()).toEqual(["cron", "interval", "manual", "on_commit"]);
    expect((await fixture.jobQueue.list()).map((job) => job.triggerKind).sort()).toEqual(["cron", "interval", "manual", "on_commit"]);
  });

  test("restart recovery requeues stale running jobs once and registers exactly one cron handle", async () => {
    const fixture = await createFixture(Date.UTC(2026, 0, 1, 0, 20, 0));
    const loop = await fixture.manager.create("project-a", cronConfig);
    const { job } = await fixture.jobQueue.enqueue({
      loopId: loop.loopId,
      triggerKind: "manual",
      subjectKey: "manual:restart",
      queuedAt: fixture.clock.now(),
      eventSummary: { summary: "stale running job" },
    });
    await fixture.jobQueue.update(job.jobId, {
      status: "running",
      startedAt: fixture.clock.now() - 1_000,
      leaseExpiresAt: fixture.clock.now() - 1,
      leaseOwnerId: "prior-incarnation",
      leaseToken: "expired-lease",
      attempts: 1,
      updatedAt: fixture.clock.now() - 1_000,
    });
    const recoveredSpy = mock(fixture.jobQueue.recoverStaleRunning.bind(fixture.jobQueue));
    fixture.coordinator.recoverStaleRunning = recoveredSpy;

    await fixture.scheduler.start("project-a");
    await fixture.scheduler.start("project-a");

    expect(recoveredSpy).toHaveBeenCalledTimes(1);
    expect(fixture.cron.size()).toBe(1);
    expect((await fixture.jobQueue.list()).find((entry) => entry.jobId === job.jobId)).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(fixture.runs).toHaveLength(1);
  });

  test("invalid cron expression is rejected before scheduler registration", async () => {
    const fixture = await createFixture(Date.UTC(2026, 0, 1, 0, 0, 0));
    await expect(fixture.manager.create("project-a", {
      ...cronConfig,
      schedule: { kind: "cron", expression: "0 0 30 2 *" },
    })).rejects.toThrow("valid future UTC occurrence");

    expect(fixture.cron.size()).toBe(0);
  });

  test("cron handler rejection is caught and recorded as scheduler health", async () => {
    const fixture = await createFixture(Date.UTC(2026, 0, 1, 0, 0, 0), { maxJobs: 0 });
    const loop = await fixture.manager.create("project-a", cronConfig);

    await fixture.scheduler.start("project-a");
    await fixture.cron.fire(fixture.cron.handles()[0]!, Date.UTC(2026, 0, 1, 0, 15, 0));

    const state = await fixture.manager.read(loop.loopId);
    expect(fixture.runs).toEqual([]);
    expect(state.triggerHealth?.find((entry) => entry.triggerKind === "cron")).toMatchObject({
      status: "degraded",
      lastError: expect.stringMatching(/maxJobs/i),
    });
  });
});

async function createFixture(now: number = 0, options: { maxJobs?: number; localHead?: { repoId: string; branch: string; sha: string } } = {}): Promise<{
  manager: LoopStateManager;
  scheduler: LoopScheduler;
  clock: FakeClock;
  timer: FakeTimer;
  cron: FakeCronAdapter;
  jobQueue: LoopJobQueue;
  coordinator: LoopJobCoordinator;
  killStateManager: LoopKillStateManager;
  budgetLedger: LoopBudgetLedger;
  collisionLedger: CollisionLedger;
  executionManager: FakeSessionFamilyStopper;
  runs: LoopSchedulerRunInput[];
  runner: (input: LoopSchedulerRunInput) => Promise<LoopSchedulerRunResult>;
  createScheduler: (
    triggerPoller?: LoopTriggerPoller,
    coordinatorOverride?: LoopJobCoordinator,
    cleanupJob?: (jobId: string) => Promise<import("./cleanup").LoopCleanupWorktreeResult | undefined>,
    readSessionAttempt?: NonNullable<ConstructorParameters<typeof LoopScheduler>[0]["readSessionAttempt"]>,
    continueGoalRun?: ConstructorParameters<typeof LoopScheduler>[0]["continueGoalRun"],
    reconcileGoalState?: ConstructorParameters<typeof LoopScheduler>[0]["reconcileGoalState"],
  ) => LoopScheduler;
}> {
  const manager = new LoopStateManager(TMP_DIR);
  const clock = new FakeClock(now);
  const timer = new FakeTimer(clock);
  const cron = new FakeCronAdapter();
  const jobQueue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock, maxJobs: options.maxJobs });
  const killStateManager = new LoopKillStateManager(TMP_DIR, { clock });
  const budgetLedger = new LoopBudgetLedger({ stateManager: manager, workspaceRoot: TMP_DIR, clock });
  const collisionLedger = new CollisionLedger({ stateManager: manager, workspaceRoot: TMP_DIR, clock, leaseTtlMs: 60_000 });
  const coordinator = new LoopJobCoordinator({ queue: jobQueue, clock, leaseTtlMs: 60_000 });
  const executionManager = new FakeSessionFamilyStopper();
  const triggerPoller = new LoopTriggerPoller({
    workspaceRoot: TMP_DIR,
    stateManager: manager,
    queue: jobQueue,
    localGit: options.localHead === undefined ? undefined : new FakeLocalGit(options.localHead),
    clock,
  });
  const runs: LoopSchedulerRunInput[] = [];
  const fixture = {
    manager,
    scheduler: undefined as unknown as LoopScheduler,
    clock,
    timer,
     cron,
     jobQueue,
     coordinator,
     killStateManager,
     budgetLedger,
    collisionLedger,
    executionManager,
    runs,
    runner: async (_input: LoopSchedulerRunInput) => ({ status: "succeeded" as const, summary: "done" }),
    createScheduler: undefined as unknown as (
      triggerPoller?: LoopTriggerPoller,
      coordinatorOverride?: LoopJobCoordinator,
      cleanupJob?: (jobId: string) => Promise<import("./cleanup").LoopCleanupWorktreeResult | undefined>,
    readSessionAttempt?: NonNullable<ConstructorParameters<typeof LoopScheduler>[0]["readSessionAttempt"]>,
    continueGoalRun?: ConstructorParameters<typeof LoopScheduler>[0]["continueGoalRun"],
    reconcileGoalState?: ConstructorParameters<typeof LoopScheduler>[0]["reconcileGoalState"],
    ) => LoopScheduler,
  };
  fixture.createScheduler = (
    nextTriggerPoller = triggerPoller,
    coordinatorOverride = coordinator,
    cleanupJob = async () => undefined,
    readSessionAttempt = async () => ({}),
    continueGoalRun,
    reconcileGoalState,
  ) => new LoopScheduler({
    stateManager: manager,
    clock,
    timer,
    cronAdapter: cron,
    jobQueue,
    coordinator: coordinatorOverride,
    budgetLedger,
    collisionLedger,
    killStateManager,
    triggerPoller: nextTriggerPoller,
    stopSessionFamily: (sessionId) => executionManager.stopSessionFamily(TMP_DIR, sessionId),
    hitl: createLoopTestHitlService(TMP_DIR, manager),
    runner: async (input) => {
      runs.push(input);
      return await fixture.runner(input);
    },
    ...(continueGoalRun === undefined ? {} : { continueGoalRun }),
    ...(reconcileGoalState === undefined ? {} : { reconcileGoalState }),
    cleanupJob,
    readSessionAttempt,
  });
  fixture.scheduler = fixture.createScheduler();
  return fixture;
}

class FakeLocalGit implements LoopLocalGitReader {
  constructor(private readonly head: { repoId: string; branch: string; sha: string }) {}

  async readBranchHead(branch?: string): Promise<{ repoId: string; branch: string; sha: string }> {
    return { ...this.head, branch: branch ?? this.head.branch };
  }
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

function executionLease(job: LoopJobRecord): { leaseOwnerId: string; leaseToken: string } {
  if (job.leaseOwnerId === undefined || job.leaseToken === undefined) throw new Error("Expected claimed Loop job lease");
  return { leaseOwnerId: job.leaseOwnerId, leaseToken: job.leaseToken };
}

function recoveredCheckpoint(
  run: { runId: string; loopId: string; trigger: "manual" },
  jobId: string,
  hitlId: string,
) {
  return {
    version: 1 as const,
    hitlId,
    loopId: run.loopId,
    runId: run.runId,
    jobId,
    trigger: run.trigger,
    intendedContinuation: "resume_run" as const,
  };
}

async function waitFor(predicate: () => Promise<boolean>, attempts: number = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not met before timeout");
}
