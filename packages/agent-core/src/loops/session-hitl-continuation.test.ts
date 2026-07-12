import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GoalState } from "../goals/state";

import { CollisionLedger } from "./collision-ledger";
import { LoopJobCoordinator } from "./coordinator";
import { LoopJobQueue, type LoopJobRecord } from "./job-queue";
import { LoopSessionHitlContinuationCoordinator } from "./session-hitl-continuation";
import { LoopStateManager, type LoopRunReport, type LoopState } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-hitl-continuation");

describe("LoopSessionHitlContinuationCoordinator", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("requires cleanup scheduling at construction", async () => {
    const fixture = await createBlockedFixture();
    expect(() => new LoopSessionHitlContinuationCoordinator({
      stateManager: fixture.stateManager,
      jobQueue: fixture.jobQueue,
      jobCoordinator: fixture.jobCoordinator,
      collisionLedger: fixture.collisionLedger,
    } as ConstructorParameters<typeof LoopSessionHitlContinuationCoordinator>[0])).toThrow("requires cleanup scheduling");
  });

  test("collision failure rolls the exact job back to needs_user and preserves the Loop blocker", async () => {
    const fixture = await createBlockedFixture();
    const competingLoop = await createLoop(fixture.stateManager, "competing");
    expect((await fixture.collisionLedger.acquire({
      target: { type: "file", path: "." },
      loopId: competingLoop.loopId,
      runId: "competing-run",
      priority: 10,
    })).acquired).toBe(true);

    await expect(fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    })).rejects.toMatchObject({
      name: "LoopSessionHitlContinuationConflictError",
      reason: "collision_conflict",
    });

    expect(await fixture.jobQueue.read(fixture.job.jobId)).toMatchObject({
      status: "needs_user",
      blockedByHitlIds: [fixture.hitlId],
      attentionStatus: "waiting_for_human",
    });
    const state = await fixture.stateManager.read(fixture.loop.loopId);
    expect(state.currentRun).toMatchObject({ status: "needs_user", blockedByHitlIds: [fixture.hitlId] });
    expect(state.resumeCheckpoint?.hitlId).toBe(fixture.hitlId);
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([
      expect.objectContaining({ loopId: competingLoop.loopId, runId: "competing-run" }),
    ]);
  });

  test("capacity failure does not claim or clear a Session HITL-blocked Loop", async () => {
    const fixture = await createBlockedFixture({ maxConcurrent: 1 });
    const otherLoop = await createLoop(fixture.stateManager, "capacity");
    await fixture.jobQueue.enqueue({
      loopId: otherLoop.loopId,
      triggerKind: "manual",
      subjectKey: `manual:${otherLoop.loopId}`,
      priority: 100,
    });
    expect(await fixture.jobCoordinator.dispatchReady()).toHaveLength(1);

    await expect(fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    })).rejects.toMatchObject({
      name: "LoopSessionHitlContinuationConflictError",
      reason: "job_unavailable",
    });

    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("needs_user");
    expect((await fixture.stateManager.read(fixture.loop.loopId)).attentionStatus).toBe("waiting_for_human");
  });

  test("attributes a child Session HITL to the Loop-owned root Session", async () => {
    const fixture = await createBlockedFixture();

    const lease = await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: "child-session",
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });
    await lease.complete({});

    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("succeeded");
    expect((await fixture.stateManager.read(fixture.loop.loopId)).lastRun).toMatchObject({
      sessionId: fixture.sessionId,
      status: "succeeded",
    });
  });

  test("never restores a resolved HITL when remaining blockers are durable before job finish fails", async () => {
    const fixture = await createBlockedFixture();
    const remainingHitlId = crypto.randomUUID();
    const lease = await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });
    const originalReconcile = fixture.jobCoordinator.reconcileReportedFinish.bind(fixture.jobCoordinator);
    let reconcileAttempts = 0;
    Object.defineProperty(fixture.jobCoordinator, "finish", {
      value: mock(async (..._args: Parameters<LoopJobCoordinator["finish"]>): Promise<LoopJobRecord> => {
        throw new Error("injected job finish failure");
      }),
    });
    Object.defineProperty(fixture.jobCoordinator, "reconcileReportedFinish", {
      value: mock(async (...args: Parameters<LoopJobCoordinator["reconcileReportedFinish"]>): Promise<LoopJobRecord> => {
        reconcileAttempts += 1;
        if (reconcileAttempts === 1) throw new Error("injected first convergence failure");
        return await originalReconcile(...args);
      }),
    });

    await expect(lease.complete({ blockedByHitlIds: [remainingHitlId] })).rejects.toThrow("injected first convergence failure");
    await lease.fail(new Error("adapter observed completion failure"));

    const state = await fixture.stateManager.read(fixture.loop.loopId);
    expect(state.currentRun).toMatchObject({
      status: "needs_user",
      blockedByHitlIds: [remainingHitlId],
      resumeCheckpoint: { hitlId: remainingHitlId },
    });
    expect(state.currentRun?.blockedByHitlIds).not.toContain(fixture.hitlId);
    expect(await fixture.jobQueue.read(fixture.job.jobId)).toMatchObject({
      status: "needs_user",
      blockedByHitlIds: [remainingHitlId],
      resumeCheckpoint: { hitlId: remainingHitlId },
    });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("starts Goal continuation only after the Session HITL family lease releases", async () => {
    const onGoalContinuationQueued = mock(() => undefined);
    const fixture = await createBlockedFixture({ goalId: "goal-owned", onGoalContinuationQueued });
    const lease = await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: "child-session",
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });

    await lease.complete({});
    expect(onGoalContinuationQueued).not.toHaveBeenCalled();
    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("pending");

    await lease.afterSessionRelease?.();
    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("pending");
    expect(onGoalContinuationQueued).toHaveBeenCalledTimes(1);
  });

  test("Goal state reconciliation requires an applied exact run/job checkpoint HITL id", async () => {
    const onGoalContinuationQueued = mock(() => undefined);
    let goal!: GoalState;
    const fixture = await createBlockedFixture({
      goalId: "goal-exact-hitl",
      onGoalContinuationQueued,
      readGoal: async () => goal,
    });
    goal = {
      id: "goal-exact-hitl",
      loopId: fixture.loop.loopId,
      mainSessionId: fixture.sessionId,
      pendingHitlIds: [],
      appliedHitlIds: [crypto.randomUUID()],
    } as unknown as GoalState;

    await fixture.continuation.reconcileGoalState(goal.id);
    expect(onGoalContinuationQueued).not.toHaveBeenCalled();
    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("needs_user");

    goal = { ...goal, appliedHitlIds: [fixture.hitlId] };
    await fixture.continuation.reconcileGoalState(goal.id);
    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("pending");
    expect(onGoalContinuationQueued).toHaveBeenCalledTimes(1);
  });

  test("approved Goal HITL requeues exact identity even while scheduler capacity is full", async () => {
    const onGoalContinuationQueued = mock(() => undefined);
    let goal!: GoalState;
    const fixture = await createBlockedFixture({
      maxConcurrent: 1,
      goalId: "goal-capacity",
      readGoal: async () => goal,
      onGoalContinuationQueued,
    });
    goal = {
      id: "goal-capacity",
      loopId: fixture.loop.loopId,
      mainSessionId: fixture.sessionId,
      pendingHitlIds: [],
      appliedHitlIds: [fixture.hitlId],
    } as unknown as GoalState;
    const otherLoop = await createLoop(fixture.stateManager, "goal-capacity-other");
    const other = await fixture.jobQueue.enqueue({
      loopId: otherLoop.loopId,
      triggerKind: "manual",
      subjectKey: `manual:${otherLoop.loopId}`,
    });
    const otherRunning = (await fixture.jobCoordinator.dispatchReady())[0]!;
    expect(otherRunning.jobId).toBe(other.job.jobId);

    await fixture.continuation.reconcileGoalState(goal.id);

    expect(await fixture.jobQueue.read(fixture.job.jobId)).toMatchObject({
      status: "pending",
      runId: fixture.origin.runId,
      sessionId: fixture.sessionId,
    });
    expect(onGoalContinuationQueued).toHaveBeenCalledTimes(1);
    expect(await fixture.jobCoordinator.dispatchReady()).toEqual([]);

    await fixture.jobCoordinator.finish(otherRunning.jobId, executionLease(otherRunning), { status: "succeeded" });
    expect(await fixture.jobCoordinator.dispatchReady()).toContainEqual(expect.objectContaining({
      jobId: fixture.job.jobId,
      status: "running",
      runId: fixture.origin.runId,
      sessionId: fixture.sessionId,
    }));
  });

  test("startup reconciliation completes a crash after Goal job requeue but before run projection", async () => {
    const onGoalContinuationQueued = mock(() => undefined);
    let goal!: GoalState;
    const fixture = await createBlockedFixture({
      goalId: "goal-requeue-crash",
      readGoal: async () => goal,
      onGoalContinuationQueued,
    });
    goal = {
      id: "goal-requeue-crash",
      status: "running",
      loopId: fixture.loop.loopId,
      mainSessionId: fixture.sessionId,
      pendingHitlIds: [],
      appliedHitlIds: [fixture.hitlId],
    } as unknown as GoalState;
    await fixture.jobCoordinator.requeueResolvedGoalHitl(fixture.job, fixture.hitlId);

    await fixture.continuation.reconcileGoalState(goal.id);

    expect(await fixture.jobQueue.read(fixture.job.jobId)).toMatchObject({
      status: "pending",
      runId: fixture.origin.runId,
      sessionId: fixture.sessionId,
    });
    expect((await fixture.stateManager.read(fixture.loop.loopId)).currentRun).toMatchObject({
      status: "running",
      runId: fixture.origin.runId,
      goalId: goal.id,
    });
    expect(onGoalContinuationQueued).toHaveBeenCalledTimes(1);
  });

  test("reconciles a committed terminal Goal into the exact Loop run/job and releases collisions", async () => {
    let goal!: GoalState;
    const fixture = await createBlockedFixture({
      goalId: "goal-cancelled",
      readGoal: async () => goal,
    });
    goal = {
      id: "goal-cancelled",
      status: "cancelled",
      loopId: fixture.loop.loopId,
      mainSessionId: fixture.sessionId,
      pendingHitlIds: [],
      appliedHitlIds: [fixture.hitlId],
    } as unknown as GoalState;

    await fixture.continuation.reconcileGoalState(goal.id);

    const state = await fixture.stateManager.read(fixture.loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state).toMatchObject({
      lastRun: {
        runId: fixture.origin.runId,
        goalId: goal.id,
        status: "cancelled",
        reason: "cancelled_by_user",
      },
    });
    expect(await fixture.jobQueue.read(fixture.job.jobId)).toMatchObject({ status: "cancelled" });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("retries terminal Goal job convergence from the exact report without incrementing runCount twice", async () => {
    let goal!: GoalState;
    const fixture = await createBlockedFixture({
      goalId: "goal-terminal-retry",
      readGoal: async () => goal,
    });
    goal = {
      id: "goal-terminal-retry",
      status: "cancelled",
      loopId: fixture.loop.loopId,
      mainSessionId: fixture.sessionId,
      pendingHitlIds: [],
      appliedHitlIds: [fixture.hitlId],
    } as unknown as GoalState;
    const originalReconcile = fixture.jobCoordinator.reconcileReportedFinish.bind(fixture.jobCoordinator);
    let attempts = 0;
    Object.defineProperty(fixture.jobCoordinator, "reconcileReportedFinish", {
      value: mock(async (...args: Parameters<LoopJobCoordinator["reconcileReportedFinish"]>): Promise<LoopJobRecord> => {
        attempts += 1;
        if (attempts === 1) throw new Error("injected terminal job convergence failure");
        return await originalReconcile(...args);
      }),
    });

    await expect(fixture.continuation.reconcileGoalState(goal.id)).rejects.toThrow("injected terminal job convergence failure");
    const reportFirst = await fixture.stateManager.read(fixture.loop.loopId);
    expect(reportFirst.currentRun).toBeUndefined();
    expect(reportFirst.lastRun).toMatchObject({
      runId: fixture.origin.runId,
      goalId: goal.id,
      status: "cancelled",
    });
    expect(reportFirst.runCount).toBe(1);
    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("needs_user");

    await fixture.continuation.reconcileGoalState(goal.id);

    const converged = await fixture.stateManager.read(fixture.loop.loopId);
    expect(converged.runCount).toBe(1);
    expect(converged.currentRun).toBeUndefined();
    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("cancelled");
    expect(attempts).toBe(2);
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("advances multiple Goal HITL checkpoints in reverse resolution order", async () => {
    const secondHitlId = crypto.randomUUID();
    const onGoalContinuationQueued = mock(() => undefined);
    let goal!: GoalState;
    const fixture = await createBlockedFixture({
      goalId: "goal-multi-hitl",
      readGoal: async () => goal,
      onGoalContinuationQueued,
    });
    const blocked = (await fixture.stateManager.read(fixture.loop.loopId)).currentRun!;
    await fixture.stateManager.recordRunBlocked(fixture.loop.loopId, {
      ...blocked,
      blockedByHitlIds: [fixture.hitlId, secondHitlId],
    });
    await fixture.jobQueue.update(fixture.job.jobId, {
      blockedByHitlIds: [fixture.hitlId, secondHitlId],
    });
    goal = {
      id: "goal-multi-hitl",
      loopId: fixture.loop.loopId,
      mainSessionId: fixture.sessionId,
      pendingHitlIds: [fixture.hitlId],
      appliedHitlIds: [secondHitlId],
    } as unknown as GoalState;

    await fixture.continuation.reconcileGoalState(goal.id);

    expect((await fixture.stateManager.read(fixture.loop.loopId)).currentRun).toMatchObject({
      blockedByHitlIds: [fixture.hitlId],
      resumeCheckpoint: { hitlId: fixture.hitlId },
    });
    expect(await fixture.jobQueue.read(fixture.job.jobId)).toMatchObject({
      blockedByHitlIds: [fixture.hitlId],
      resumeCheckpoint: { hitlId: fixture.hitlId },
    });
    expect(onGoalContinuationQueued).not.toHaveBeenCalled();

    goal = { ...goal, pendingHitlIds: [], appliedHitlIds: [secondHitlId, fixture.hitlId] };
    await fixture.continuation.reconcileGoalState(goal.id);

    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("pending");
    expect(onGoalContinuationQueued).toHaveBeenCalledTimes(1);
  });

  test("a new process incarnation recovers and reclaims an interrupted resume_run lease", async () => {
    const fixture = await createBlockedFixture();
    await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });
    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("running");
    expect((await fixture.stateManager.read(fixture.loop.loopId)).currentRun?.status).toBe("running");

    const restartedJobCoordinator = new LoopJobCoordinator({
      queue: fixture.jobQueue,
      clock: { now: () => 2_000 },
      incarnationId: "restarted-session-hitl-continuation",
    });
    const recovered = await restartedJobCoordinator.start();
    expect(recovered).toContainEqual(expect.objectContaining({
      jobId: fixture.job.jobId,
      status: "needs_user",
      blockedByHitlIds: [fixture.hitlId],
    }));
    const restarted = new LoopSessionHitlContinuationCoordinator({
      stateManager: fixture.stateManager,
      jobQueue: fixture.jobQueue,
      jobCoordinator: restartedJobCoordinator,
      collisionLedger: fixture.collisionLedger,
      now: () => 2_000,
      scheduleCleanup: () => undefined,
    });
    const lease = await restarted.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });
    await lease.complete({});

    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("succeeded");
    const state = await fixture.stateManager.read(fixture.loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun?.status).toBe("succeeded");
  });

  test("successful worktree continuation re-enters cleanup saga after the Session lease releases", async () => {
    const fixture = await createBlockedFixture();
    const worktreePath = join(fixture.workspaceRoot, ".archcode", "worktrees", "job");
    await fixture.jobQueue.update(fixture.job.jobId, {
      worktreePath,
      worktreeBranchName: "archcode/loop/test/continuation",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "a".repeat(40),
      cleanupState: "preserved",
    });
    const blocked = (await fixture.stateManager.read(fixture.loop.loopId)).currentRun!;
    await fixture.stateManager.recordRunBlocked(fixture.loop.loopId, {
      ...blocked,
      worktreePath,
      worktreeBranchName: "archcode/loop/test/continuation",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "a".repeat(40),
      cleanupState: "preserved",
    });
    const scheduleCleanup = mock((_input: { loopId: string; runId: string; jobId: string }) => undefined);
    const continuation = new LoopSessionHitlContinuationCoordinator({
      stateManager: fixture.stateManager,
      jobQueue: fixture.jobQueue,
      jobCoordinator: fixture.jobCoordinator,
      collisionLedger: fixture.collisionLedger,
      now: () => 1_000,
      scheduleCleanup,
    });

    const lease = await continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });
    await lease.complete({});

    expect((await fixture.jobQueue.read(fixture.job.jobId)).cleanupState).toBe("in_progress");
    expect((await fixture.stateManager.read(fixture.loop.loopId)).lastRun?.cleanupState).toBe("in_progress");
    expect(scheduleCleanup).not.toHaveBeenCalled();
    lease.afterSessionRelease?.();
    expect(scheduleCleanup).toHaveBeenCalledWith({
      loopId: fixture.loop.loopId,
      runId: fixture.origin.runId,
      jobId: fixture.job.jobId,
    });
  });

  test("acquire repairs a crash after terminal Loop state commits but before the job finishes", async () => {
    const fixture = await createBlockedFixture();
    await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });
    const running = (await fixture.stateManager.read(fixture.loop.loopId)).currentRun!;
    await fixture.stateManager.recordRunFinish(fixture.loop.loopId, {
      ...running,
      status: "succeeded",
      endedAt: 1_001,
      summary: "Session completed before the process crashed.",
    });
    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("running");

    const repaired = await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });

    expect(repaired.alreadyCompleted).toBe(true);
    expect(await fixture.jobQueue.read(fixture.job.jobId)).toMatchObject({
      status: "succeeded",
      attentionStatus: "clear",
    });
  });

  test("acquire repairs a crash after Loop advances to another HITL but before the job finishes", async () => {
    const fixture = await createBlockedFixture();
    await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });
    const running = (await fixture.stateManager.read(fixture.loop.loopId)).currentRun!;
    const nextHitlId = crypto.randomUUID();
    await fixture.stateManager.recordRunBlocked(fixture.loop.loopId, {
      ...running,
      status: "needs_user",
      endedAt: 1_001,
      blockedReason: "needs_user",
      blockedByHitlIds: [nextHitlId],
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: {
        version: 1,
        hitlId: nextHitlId,
        loopId: fixture.loop.loopId,
        runId: fixture.origin.runId,
        jobId: fixture.job.jobId,
        trigger: "manual",
        intendedContinuation: "resume_run",
      },
      summary: "Session is waiting for another response.",
    });
    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("running");

    const repaired = await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });

    expect(repaired.alreadyCompleted).toBe(true);
    expect(await fixture.jobQueue.read(fixture.job.jobId)).toMatchObject({
      status: "needs_user",
      blockedByHitlIds: [nextHitlId],
      resumeCheckpoint: { hitlId: nextHitlId },
    });
  });

  test("a stale continuation failure cannot move an already-cancelled run back to needs_user", async () => {
    const fixture = await createBlockedFixture();
    const lease = await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
      rootSessionId: fixture.sessionId,
      hitlId: fixture.hitlId,
    });
    const running = (await fixture.stateManager.read(fixture.loop.loopId)).currentRun!;
    const runningJob = await fixture.jobQueue.read(fixture.job.jobId);
    const cancelled: LoopRunReport = {
      ...running,
      status: "cancelled",
      endedAt: 1_001,
      reason: "cancelled_by_user",
      blockedReason: "cancelled_by_user",
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
      resumeCheckpoint: undefined,
    };
    await fixture.stateManager.recordRunFinish(fixture.loop.loopId, cancelled);
    await fixture.jobCoordinator.finish(
      runningJob.jobId,
      executionLease(runningJob),
      {
        status: "cancelled",
        blockedReason: "cancelled_by_user",
        attentionStatus: "clear",
      },
    );

    await lease.fail(new Error("late abort after cancellation committed"));

    const state = await fixture.stateManager.read(fixture.loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun).toMatchObject({
      runId: fixture.origin.runId,
      status: "cancelled",
      reason: "cancelled_by_user",
    });
    expect(state.blockedByHitlIds).toBeUndefined();
    expect(state.resumeCheckpoint).toBeUndefined();
    expect(state.attentionStatus).toBe("clear");
    const job = await fixture.jobQueue.read(fixture.job.jobId);
    expect(job).toMatchObject({ status: "cancelled", attentionStatus: "clear" });
    expect(job.blockedByHitlIds).toBeUndefined();
    expect(job.resumeCheckpoint).toBeUndefined();
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });
});

async function createBlockedFixture(options: {
  readonly maxConcurrent?: number;
  readonly goalId?: string;
  readonly readGoal?: (goalId: string) => Promise<GoalState>;
  readonly onGoalContinuationQueued?: ConstructorParameters<typeof LoopSessionHitlContinuationCoordinator>[0]["onGoalContinuationQueued"];
} = {}) {
  const workspaceRoot = join(TMP_ROOT, crypto.randomUUID());
  await mkdir(workspaceRoot, { recursive: true });
  const stateManager = new LoopStateManager(workspaceRoot);
  const loop = await createLoop(stateManager, "target");
  const jobQueue = new LoopJobQueue({ workspaceRoot, clock: { now: () => 1_000 } });
  const jobCoordinator = new LoopJobCoordinator({
    queue: jobQueue,
    clock: { now: () => 1_000 },
    incarnationId: "session-hitl-continuation-test",
    config: { maxConcurrent: options.maxConcurrent ?? 4 },
  });
  const collisionLedger = new CollisionLedger({ stateManager, workspaceRoot, clock: { now: () => 1_000 } });
  const enqueued = await jobQueue.enqueue({
    loopId: loop.loopId,
    triggerKind: "manual",
    subjectKey: `manual:${loop.loopId}`,
  });
  const claimed = (await jobCoordinator.dispatchReady())[0]!;
  const hitlId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const run: LoopRunReport = {
    runId: "run-session-hitl",
    loopId: loop.loopId,
    status: "running",
    trigger: "manual",
    startedAt: 1_000,
    jobId: claimed.jobId,
    subjectKey: claimed.subjectKey,
    sessionId,
    ...(options.goalId === undefined ? {} : { goalId: options.goalId }),
    collisionTargets: loop.config.collisionTargets,
  };
  await jobCoordinator.checkpointSessionAttempt(claimed.jobId, executionLease(claimed), {
    runId: run.runId,
    sessionId,
    sessionExecutionId: "execution-session-hitl",
  });
  await stateManager.recordRunStart(loop.loopId, run);
  await collisionLedger.acquireStaticTargets({ loop, runId: run.runId, priority: claimed.priority });
  const resumeCheckpoint = {
    version: 1 as const,
    hitlId,
    loopId: loop.loopId,
    runId: run.runId,
    jobId: claimed.jobId,
    trigger: "manual" as const,
    subjectKey: claimed.subjectKey,
    intendedContinuation: "resume_run" as const,
  };
  const blocked: LoopRunReport = {
    ...run,
    status: "needs_user",
    endedAt: 1_000,
    blockedReason: "needs_user",
    blockedByHitlIds: [hitlId],
    attentionStatus: "waiting_for_human",
    resumeCheckpoint,
    summary: "Session needs user input.",
  };
  await stateManager.recordRunBlocked(loop.loopId, blocked);
  const job = await jobCoordinator.finish(claimed.jobId, executionLease(claimed), {
    status: "needs_user",
    blockedReason: "needs_user",
    blockedByHitlIds: [hitlId],
    attentionStatus: "waiting_for_human",
    resumeCheckpoint,
  });
  await collisionLedger.releaseRun(loop.loopId, run.runId);
  const continuation = new LoopSessionHitlContinuationCoordinator({
    stateManager,
    jobQueue,
    jobCoordinator,
    collisionLedger,
    now: () => 1_000,
    scheduleCleanup: () => undefined,
    ...(options.readGoal === undefined ? {} : { readGoal: options.readGoal }),
    ...(options.onGoalContinuationQueued === undefined ? {} : { onGoalContinuationQueued: options.onGoalContinuationQueued }),
  });
  return {
    workspaceRoot,
    stateManager,
    loop,
    jobQueue,
    jobCoordinator,
    collisionLedger,
    continuation,
    job,
    hitlId,
    sessionId,
    origin: {
      kind: "loop" as const,
      loopId: loop.loopId,
      runId: run.runId,
      trigger: "manual" as const,
      approvalPolicy: "interactive" as const,
    },
  };
}

async function createLoop(stateManager: LoopStateManager, suffix: string): Promise<LoopState> {
  return await stateManager.create(`project-${suffix}`, {
    templateId: "watch_report",
    title: null,
    schedule: { kind: "manual" },
    approvalPolicy: "interactive",
    limits: { maxIterationsPerRun: 3, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
    useWorktree: false,
    collisionTargets: [{ type: "file", path: "." }],
  });
}

function executionLease(job: LoopJobRecord) {
  return { leaseOwnerId: job.leaseOwnerId!, leaseToken: job.leaseToken! };
}
