import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { LoopJobCoordinator } from "./coordinator";
import { LoopJobQueue, LoopJobQueueFileSchema } from "./job-queue";
import { FakeClock } from "./test-utils";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-coordinator");
const LOOP_ID = "0a81a593-5d3f-4a6f-a286-f7e08a64a90d";

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("LoopJobCoordinator", () => {
  test("dispatches exactly maxConcurrent non-conflicting jobs", async () => {
    const clock = new FakeClock(1_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    await enqueueBranch(queue, "one", 1);
    await enqueueBranch(queue, "two", 2);
    await enqueueBranch(queue, "three", 3);
    const coordinator = new LoopJobCoordinator({ queue, clock });

    const started = await coordinator.dispatchReady();
    const statuses = (await queue.list()).map((job) => job.status);

    expect(coordinator.maxConcurrent).toBe(2);
    expect(started).toHaveLength(2);
    expect(statuses.filter((status) => status === "running")).toHaveLength(2);
    expect(statuses.filter((status) => status === "pending")).toHaveLength(1);
  });

  test("atomically claims one pending job across concurrent coordinators", async () => {
    const clock = new FakeClock(1_500);
    const firstQueue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    await enqueueBranch(firstQueue, "single-claim", 1);
    const firstCoordinator = new LoopJobCoordinator({
      queue: firstQueue,
      clock,
      config: { maxConcurrent: 2 },
      incarnationId: "claim-process-one",
    });
    const secondQueue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const secondCoordinator = new LoopJobCoordinator({
      queue: secondQueue,
      clock,
      config: { maxConcurrent: 2 },
      incarnationId: "claim-process-two",
    });

    const claims = (await Promise.all([
      firstCoordinator.dispatchReady(),
      secondCoordinator.dispatchReady(),
    ])).flat();

    expect(claims).toHaveLength(1);
    const [job] = await firstQueue.list();
    expect(job).toMatchObject({
      status: "running",
      attempts: 1,
      leaseOwnerId: claims[0]?.leaseOwnerId,
      leaseToken: claims[0]?.leaseToken,
    });
  });

  test("rechecks global capacity and branch serialization inside concurrent claims", async () => {
    const clock = new FakeClock(1_750);
    const firstQueue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const sharedBranch = "test-owner/test-repo:feature/shared-claim";
    await enqueueBranch(firstQueue, "shared-claim-one", 1, sharedBranch, 10);
    await enqueueBranch(firstQueue, "shared-claim-two", 2, sharedBranch, 9);
    await enqueueBranch(firstQueue, "independent-claim", 3, undefined, 8);
    const firstCoordinator = new LoopJobCoordinator({
      queue: firstQueue,
      clock,
      config: { maxConcurrent: 2 },
      incarnationId: "constraint-process-one",
    });
    const secondCoordinator = new LoopJobCoordinator({
      queue: new LoopJobQueue({ workspaceRoot: TMP_DIR, clock }),
      clock,
      config: { maxConcurrent: 2 },
      incarnationId: "constraint-process-two",
    });

    const claims = (await Promise.all([
      firstCoordinator.dispatchReady(),
      secondCoordinator.dispatchReady(),
    ])).flat();
    const running = await firstQueue.list(["running"]);

    expect(claims).toHaveLength(2);
    expect(running).toHaveLength(2);
    expect(running.filter((job) => job.branchKey === sharedBranch)).toHaveLength(1);
    expect((await firstQueue.list()).reduce((attempts, job) => attempts + job.attempts, 0)).toBe(2);
  });

  test("serializes jobs with the same branchKey even when capacity is free", async () => {
    const clock = new FakeClock(2_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    await enqueueBranch(queue, "same", 1, "test-owner/test-repo:feature/shared");
    clock.set(2_001);
    await enqueueBranch(queue, "same-again", 2, "test-owner/test-repo:feature/shared");
    clock.set(2_002);
    await enqueueBranch(queue, "other", 3, "test-owner/test-repo:feature/other");
    const coordinator = new LoopJobCoordinator({ queue, clock, config: { maxConcurrent: 3 } });

    const started = await coordinator.dispatchReady();
    const running = await queue.list(["running"]);

    expect(started.map((job) => job.subjectKey)).toEqual(["branch:same", "branch:other"]);
    expect(running.map((job) => job.branchKey)).toEqual(["test-owner/test-repo:feature/shared", "test-owner/test-repo:feature/other"]);
    expect((await queue.list(["pending"])).map((job) => job.subjectKey)).toEqual(["branch:same-again"]);
  });

  test("preserves FIFO order within the same priority after higher priority jobs", async () => {
    const clock = new FakeClock(3_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    await enqueueBranch(queue, "low", 1, undefined, 1);
    clock.set(3_100);
    await enqueueBranch(queue, "high-first", 2, undefined, 10);
    clock.set(3_200);
    await enqueueBranch(queue, "high-second", 3, undefined, 10);
    const coordinator = new LoopJobCoordinator({ queue, clock, config: { maxConcurrent: 1 } });

    expect((await coordinator.dispatchReady()).map((job) => job.subjectKey)).toEqual(["branch:high-first"]);
    const firstRunning = (await queue.list(["running"]))[0]!;
    await coordinator.finish(firstRunning.jobId, executionLeaseFor(firstRunning), { status: "succeeded" });
    expect((await coordinator.dispatchReady()).map((job) => job.subjectKey)).toEqual(["branch:high-second"]);
    const secondRunning = (await queue.list(["running"]))[0]!;
    await coordinator.finish(secondRunning.jobId, executionLeaseFor(secondRunning), { status: "succeeded" });
    expect((await coordinator.dispatchReady()).map((job) => job.subjectKey)).toEqual(["branch:low"]);
  });

  test("recovers stale running jobs on startup and clears stuck serialization", async () => {
    const clock = new FakeClock(4_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    await enqueueBranch(queue, "stale", 1, "test-owner/test-repo:feature/stale");
    const firstCoordinator = new LoopJobCoordinator({ queue, clock, config: { maxConcurrent: 1 }, leaseTtlMs: 100 });
    const [started] = await firstCoordinator.dispatchReady();
    expect(started?.status).toBe("running");

    clock.set(4_101);
    const restartedQueue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const restartedCoordinator = new LoopJobCoordinator({ queue: restartedQueue, clock, config: { maxConcurrent: 1 }, leaseTtlMs: 100 });

    const recovered = await restartedCoordinator.start();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: "pending", branchKey: "test-owner/test-repo:feature/stale" });
    expect(recovered[0]?.leaseExpiresAt).toBeUndefined();

    const [redispatched] = await restartedCoordinator.dispatchReady();
    expect(redispatched).toMatchObject({ status: "running", branchKey: "test-owner/test-repo:feature/stale" });

    const parsed = LoopJobQueueFileSchema.parse(JSON.parse(await Bun.file(await restartedQueue.queuePath()).text()));
    expect(parsed.jobs[0]?.status).toBe("running");
  });

  test("recovers a prior process incarnation before its lease expires without interrupting the current incarnation", async () => {
    const clock = new FakeClock(4_500);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    await enqueueBranch(queue, "restart-before-expiry", 1);
    const firstCoordinator = new LoopJobCoordinator({
      queue,
      clock,
      config: { maxConcurrent: 1 },
      leaseTtlMs: 60_000,
      incarnationId: "process-one",
    });
    const [started] = await firstCoordinator.dispatchReady();
    expect(started).toMatchObject({ status: "running", leaseOwnerId: "process-one", leaseExpiresAt: 64_500 });

    expect(await firstCoordinator.start()).toEqual([]);
    expect((await queue.read(started!.jobId)).status).toBe("running");

    clock.set(4_501);
    const restartedCoordinator = new LoopJobCoordinator({
      queue: new LoopJobQueue({ workspaceRoot: TMP_DIR, clock }),
      clock,
      config: { maxConcurrent: 1 },
      leaseTtlMs: 60_000,
      incarnationId: "process-two",
    });
    const recovered = await restartedCoordinator.start();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ jobId: started!.jobId, status: "pending" });
    expect(recovered[0]?.leaseOwnerId).toBeUndefined();
    expect(recovered[0]?.leaseExpiresAt).toBeUndefined();
  });

  test("checkpoints execution worktree metadata only while the job is running", async () => {
    const clock = new FakeClock(4_750);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    await enqueueBranch(queue, "checkpoint", 1);
    const coordinator = new LoopJobCoordinator({ queue, clock, incarnationId: "checkpoint-process" });
    const [running] = await coordinator.dispatchReady();
    const checkpoint = {
      worktreePath: "/tmp/loop-checkpoint-worktree",
      worktreeBranchName: "archcode/loop/test/checkpoint",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "b".repeat(40),
    };

    const baseCheckpoint = await coordinator.checkpointBaseSha(running!.jobId, executionLeaseFor(running!), checkpoint.baseSha);
    expect(baseCheckpoint).toMatchObject({
      status: "running",
      baseSha: checkpoint.baseSha,
    });
    expect(baseCheckpoint.worktreePath).toBeUndefined();
    await expect(coordinator.checkpointWorktree(running!.jobId, executionLeaseFor(running!), checkpoint)).resolves.toMatchObject(checkpoint);
    expect(await queue.read(running!.jobId)).toMatchObject({ status: "running", ...checkpoint });

    await coordinator.finish(running!.jobId, executionLeaseFor(running!), { status: "succeeded" });
    await expect(coordinator.checkpointBaseSha(running!.jobId, executionLeaseFor(running!), checkpoint.baseSha)).rejects.toMatchObject({
      name: "LoopJobExecutionLeaseError",
      jobId: running!.jobId,
    });
    await expect(coordinator.checkpointWorktree(running!.jobId, executionLeaseFor(running!), checkpoint)).rejects.toMatchObject({
      name: "LoopJobExecutionLeaseError",
      jobId: running!.jobId,
    });
  });

  test("rejects stale execution tokens after redispatch and after cancellation", async () => {
    const clock = new FakeClock(4_800);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    await enqueueBranch(queue, "lease-cas", 1);
    const coordinator = new LoopJobCoordinator({ queue, clock, incarnationId: "lease-process" });
    const [firstExecution] = await coordinator.dispatchReady();
    const firstLease = executionLeaseFor(firstExecution!);
    await coordinator.checkpointBaseSha(firstExecution!.jobId, firstLease, "a".repeat(40));
    await coordinator.requeueWorktreePreparationFailure(firstExecution!.jobId, firstLease);

    const [secondExecution] = await coordinator.dispatchReady();
    const secondLease = executionLeaseFor(secondExecution!);
    expect(secondLease.leaseOwnerId).toBe(firstLease.leaseOwnerId);
    expect(secondLease.leaseToken).not.toBe(firstLease.leaseToken);

    await expect(coordinator.checkpointWorktree(firstExecution!.jobId, firstLease, {
      worktreePath: "/tmp/stale-execution-worktree",
      worktreeBranchName: "archcode/loop/test/stale",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "a".repeat(40),
    })).rejects.toMatchObject({ name: "LoopJobExecutionLeaseError", expectedLease: firstLease });
    await expect(coordinator.finish(firstExecution!.jobId, firstLease, { status: "failed" })).rejects.toMatchObject({
      name: "LoopJobExecutionLeaseError",
      expectedLease: firstLease,
    });
    expect(await queue.read(firstExecution!.jobId)).toMatchObject({ status: "running", ...secondLease });

    await coordinator.finish(secondExecution!.jobId, secondLease, { status: "cancelled" });
    await expect(coordinator.finish(secondExecution!.jobId, secondLease, { status: "succeeded" })).rejects.toMatchObject({
      name: "LoopJobExecutionLeaseError",
      expectedLease: secondLease,
    });
    expect((await queue.read(secondExecution!.jobId)).status).toBe("cancelled");
  });

  test("preserves a coalesced rerun while recovering the current execution from a prior incarnation", async () => {
    const clock = new FakeClock(4_900);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const oldSha = "7".repeat(40);
    const newSha = "8".repeat(40);
    await enqueueBranch(queue, "restart-rerun", 1, undefined, 0, oldSha);
    const firstCoordinator = new LoopJobCoordinator({
      queue,
      clock,
      config: { maxConcurrent: 1 },
      leaseTtlMs: 60_000,
      incarnationId: "rerun-process-one",
    });
    await firstCoordinator.dispatchReady();
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:restart-rerun",
      baseSha: newSha,
      eventSummary: { summary: "new commit before restart", payloadSha: newSha },
    });

    const restartedCoordinator = new LoopJobCoordinator({
      queue: new LoopJobQueue({ workspaceRoot: TMP_DIR, clock }),
      clock,
      config: { maxConcurrent: 1 },
      leaseTtlMs: 60_000,
      incarnationId: "rerun-process-two",
    });
    const [recovered] = await restartedCoordinator.start();
    expect(recovered).toMatchObject({
      status: "pending",
      baseSha: oldSha,
      rerunAfterCurrent: true,
      rerunInput: { baseSha: newSha },
    });

    const [resumed] = await restartedCoordinator.dispatchReady();
    await restartedCoordinator.finish(resumed!.jobId, executionLeaseFor(resumed!), { status: "succeeded" });

    const jobs = await queue.list();
    expect(jobs.map((job) => job.status)).toEqual(["succeeded", "pending"]);
    expect(jobs[0]?.baseSha).toBe(oldSha);
    expect(jobs[1]?.baseSha).toBe(newSha);
  });

  test("finishes a running duplicate by creating one pending rerun", async () => {
    const clock = new FakeClock(5_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const oldSha = "1".repeat(40);
    const newSha = "2".repeat(40);
    await enqueueBranch(queue, "rerun", 1, undefined, 0, oldSha);
    const coordinator = new LoopJobCoordinator({ queue, clock, config: { maxConcurrent: 1 } });
    const [running] = await coordinator.dispatchReady();
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:rerun",
      baseSha: newSha,
      eventSummary: { summary: "new commit while running", payloadSha: newSha },
    });

    await coordinator.finish(running!.jobId, executionLeaseFor(running!), { status: "succeeded" });

    const jobs = await queue.list();
    expect(jobs.map((job) => job.status)).toEqual(["succeeded", "pending"]);
    expect(jobs[1]?.dedupeKey).toBe(jobs[0]?.dedupeKey);
    expect(jobs[0]?.baseSha).toBe(oldSha);
    expect(jobs[1]?.baseSha).toBe(newSha);
    expect(jobs[1]?.eventSummaries.at(-1)?.summary).toBe("Queued rerun requested while previous job was running");
  });

  test("rerun keeps coalesced trigger metadata when finish records current-run execution metadata", async () => {
    const clock = new FakeClock(6_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const oldBaseSha = "0".repeat(40);
    const oldSha = "1".repeat(40);
    const newBaseSha = "2".repeat(40);
    const executionSha = "4".repeat(40);
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:rerun-exec",
      branchKey: "test-owner/test-repo:feature/rerun-exec",
      collisionTarget: { type: "branch", owner: "test-owner", repo: "test-repo", branch: "feature/rerun-exec" },
      worktreePath: "/tmp/old-trigger-worktree",
      worktreeBranchName: "archcode/loop/test/old-trigger",
      baseSha: oldBaseSha,
      resolvedHeadSha: oldSha,
      eventSummary: { summary: "old commit", payloadSha: oldSha },
    });
    const coordinator = new LoopJobCoordinator({ queue, clock, config: { maxConcurrent: 1 } });
    const [running] = await coordinator.dispatchReady();
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:rerun-exec",
      branchKey: "test-owner/test-repo:feature/rerun-exec",
      collisionTarget: { type: "branch", owner: "test-owner", repo: "test-repo", branch: "feature/rerun-exec" },
      baseSha: newBaseSha,
      eventSummary: { summary: "new commit while running", payloadSha: newBaseSha },
    });

    await coordinator.checkpointWorktree(running!.jobId, executionLeaseFor(running!), {
      worktreePath: "/tmp/current-run-output-worktree",
      worktreeBranchName: "archcode/loop/test/current-output",
      baseSha: oldBaseSha,
      resolvedHeadSha: oldSha,
    });

    await coordinator.finish(running!.jobId, executionLeaseFor(running!), {
      status: "succeeded",
      worktreePath: "/tmp/current-run-output-worktree",
      worktreeBranchName: "archcode/loop/test/current-output",
      baseSha: oldBaseSha,
      resolvedHeadSha: executionSha,
      summary: "current run finished with execution metadata",
    });

    const jobs = await queue.list();
    expect(jobs.map((job) => job.status)).toEqual(["succeeded", "pending"]);
    expect(jobs[0]).toMatchObject({
      worktreePath: "/tmp/current-run-output-worktree",
      baseSha: oldBaseSha,
      resolvedHeadSha: executionSha,
    });
    expect(jobs[1]).toMatchObject({
      baseSha: newBaseSha,
    });
    expect(jobs[1]?.resolvedHeadSha).toBeUndefined();
    expect(jobs[1]?.worktreePath).toBeUndefined();
    expect(jobs[1]?.jobId).not.toBe(jobs[0]?.jobId);
  });

  test("terminal rerun never carries a worktree owned by the previous job id", async () => {
    const clock = new FakeClock(7_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const baseSha = "5".repeat(40);
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:worktree-rerun",
      worktreePath: "/tmp/worktree-owned-by-first-job",
      worktreeBranchName: "archcode/loop/test/first-job",
      baseSha,
      resolvedHeadSha: baseSha,
      eventSummary: { summary: "first worktree run" },
    });
    const coordinator = new LoopJobCoordinator({ queue, clock, config: { maxConcurrent: 1 } });
    const [running] = await coordinator.dispatchReady();
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:worktree-rerun",
      baseSha: "6".repeat(40),
      eventSummary: { summary: "new commit while worktree run is active" },
    });

    await coordinator.finish(running!.jobId, executionLeaseFor(running!), { status: "succeeded" });

    const jobs = await queue.list();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ status: "succeeded", worktreePath: "/tmp/worktree-owned-by-first-job" });
    expect(jobs[1]).toMatchObject({ status: "pending", baseSha: "6".repeat(40) });
    expect(jobs[1]?.jobId).not.toBe(jobs[0]?.jobId);
    expect(jobs[1]?.worktreePath).toBeUndefined();
  });
});

async function enqueueBranch(queue: LoopJobQueue, name: string, index: number, branchKey?: string, priority = 0, baseSha?: string): Promise<void> {
  await queue.enqueue({
    loopId: LOOP_ID,
    triggerKind: "on_commit",
    subjectKey: `branch:${name}`,
    branchKey: branchKey ?? `test-owner/test-repo:feature/${name}`,
    collisionTarget: { type: "branch", owner: "test-owner", repo: "test-repo", branch: `feature/${name}` },
    priority,
    baseSha,
    eventSummary: { summary: `commit ${index}` },
  });
}

function executionLeaseFor(job: { readonly leaseOwnerId?: string; readonly leaseToken?: string }): { leaseOwnerId: string; leaseToken: string } {
  if (job.leaseOwnerId === undefined || job.leaseToken === undefined) throw new Error("Expected running job execution lease");
  return { leaseOwnerId: job.leaseOwnerId, leaseToken: job.leaseToken };
}
