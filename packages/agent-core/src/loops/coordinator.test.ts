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
    await coordinator.finish((await queue.list(["running"]))[0]!.jobId, { status: "succeeded" });
    expect((await coordinator.dispatchReady()).map((job) => job.subjectKey)).toEqual(["branch:high-second"]);
    await coordinator.finish((await queue.list(["running"]))[0]!.jobId, { status: "succeeded" });
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
      resolvedHeadSha: newSha,
      eventSummary: { summary: "new commit while running", payloadSha: newSha },
    });

    await coordinator.finish(running!.jobId, { status: "succeeded" });

    const jobs = await queue.list();
    expect(jobs.map((job) => job.status)).toEqual(["succeeded", "pending"]);
    expect(jobs[1]?.dedupeKey).toBe(jobs[0]?.dedupeKey);
    expect(jobs[0]?.resolvedHeadSha).toBe(newSha);
    expect(jobs[1]?.resolvedHeadSha).toBe(newSha);
    expect(jobs[1]?.eventSummaries.at(-1)?.summary).toBe("Queued rerun requested while previous job was running");
  });

  test("rerun keeps coalesced trigger metadata when finish records current-run execution metadata", async () => {
    const clock = new FakeClock(6_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const oldBaseSha = "0".repeat(40);
    const oldSha = "1".repeat(40);
    const newBaseSha = "2".repeat(40);
    const newSha = "3".repeat(40);
    const executionSha = "4".repeat(40);
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:rerun-exec",
      branchKey: "test-owner/test-repo:feature/rerun-exec",
      collisionTarget: { type: "branch", owner: "test-owner", repo: "test-repo", branch: "feature/rerun-exec" },
      worktreePath: "/tmp/old-trigger-worktree",
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
      worktreePath: "/tmp/coalesced-trigger-worktree",
      baseSha: newBaseSha,
      resolvedHeadSha: newSha,
      eventSummary: { summary: "new commit while running", payloadSha: newSha },
    });

    await coordinator.finish(running!.jobId, {
      status: "succeeded",
      worktreePath: "/tmp/current-run-output-worktree",
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
      worktreePath: "/tmp/coalesced-trigger-worktree",
      baseSha: newBaseSha,
      resolvedHeadSha: newSha,
    });
  });
});

async function enqueueBranch(queue: LoopJobQueue, name: string, index: number, branchKey?: string, priority = 0, resolvedHeadSha?: string): Promise<void> {
  await queue.enqueue({
    loopId: LOOP_ID,
    triggerKind: "on_commit",
    subjectKey: `branch:${name}`,
    branchKey: branchKey ?? `test-owner/test-repo:feature/${name}`,
    collisionTarget: { type: "branch", owner: "test-owner", repo: "test-repo", branch: `feature/${name}` },
    priority,
    resolvedHeadSha,
    eventSummary: { summary: `commit ${index}` },
  });
}
