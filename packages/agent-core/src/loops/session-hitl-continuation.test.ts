import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

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
      hitlId: fixture.hitlId,
    })).rejects.toMatchObject({
      name: "LoopSessionHitlContinuationConflictError",
      reason: "job_unavailable",
    });

    expect((await fixture.jobQueue.read(fixture.job.jobId)).status).toBe("needs_user");
    expect((await fixture.stateManager.read(fixture.loop.loopId)).attentionStatus).toBe("waiting_for_human");
  });

  test("a new process incarnation recovers and reclaims an interrupted resume_run lease", async () => {
    const fixture = await createBlockedFixture();
    await fixture.continuation.acquire({
      origin: fixture.origin,
      sessionId: fixture.sessionId,
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

async function createBlockedFixture(options: { readonly maxConcurrent?: number } = {}) {
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
    collisionTargets: loop.config.collisionTargets,
  };
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
