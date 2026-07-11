import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { canonicalTargetKey } from "./collision-ledger";
import { __queueLockCountForTest, LoopJobQueue, LoopJobQueueFileSchema, LoopJobQueueLimitError, LoopJobQueueParseError, LoopJobQueueSecurityError, LoopJobRecordSchema } from "./job-queue";
import type { LoopJobStatus } from "./state";
import { FakeClock } from "./test-utils";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "job-queue");
const LOOP_ID = "9e8ff6e2-4b5d-4078-9330-718cbcd4dd9c";

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-queue-archcode"), { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-queue-loops"), { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-queue-archcode"), { recursive: true, force: true }).catch(() => {});
  await rm(join(TMP_DIR, "..", "outside-queue-loops"), { recursive: true, force: true }).catch(() => {});
});

describe("LoopJobQueue", () => {
  test("persists every job status and survives restart", async () => {
    const clock = new FakeClock(1_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const statuses: LoopJobStatus[] = ["pending", "running", "blocked", "succeeded", "failed", "cancelled", "skipped", "expired"];

    for (const [index, status] of statuses.entries()) {
      clock.set(1_000 + index);
      const { job } = await queue.enqueue({
        loopId: LOOP_ID,
        triggerKind: "cron",
        subjectKey: `cron:${index}`,
        eventSummary: { summary: `scheduled ${index}` },
      });
      if (status !== "pending") await queue.update(job.jobId, {
        status,
        startedAt: 2_000 + index,
        ...(status === "running" ? {
          leaseExpiresAt: 10_000,
          leaseOwnerId: "test-incarnation",
          leaseToken: `lease-${index}`,
        } : {}),
      });
    }

    const restarted = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(9_000) });
    expect((await restarted.list()).map((job) => job.status)).toEqual(statuses);

    const queuePath = await restarted.queuePath();
    const parsed = LoopJobQueueFileSchema.parse(JSON.parse(await Bun.file(queuePath).text()));
    expect(parsed.jobs).toHaveLength(statuses.length);
    expect((await readdir(join(TMP_DIR, ".archcode", "loops"))).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });

  test("rejects queue records created before required CAS revisions", async () => {
    const clock = new FakeClock(9_500);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const { job } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "manual",
      subjectKey: "manual:legacy-revision",
    });
    const queuePath = await queue.queuePath();
    const persisted = JSON.parse(await Bun.file(queuePath).text()) as { jobs: Array<Record<string, unknown>> };
    delete persisted.jobs[0]?.revision;
    await Bun.write(queuePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const restarted = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    await expect(restarted.read(job.jobId)).rejects.toBeInstanceOf(LoopJobQueueParseError);
  });

  test("refines status leases and complete worktree checkpoints", async () => {
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(9_600) });
    const { job } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_pr",
      subjectKey: "pr:test-owner/test-repo#1",
    });
    const running = {
      ...job,
      status: "running" as const,
      startedAt: 9_600,
      leaseExpiresAt: 19_600,
      leaseOwnerId: "incarnation-1",
      leaseToken: "lease-1",
    };

    expect(LoopJobRecordSchema.safeParse(running).success).toBe(true);
    expect(LoopJobRecordSchema.safeParse({ ...running, leaseToken: undefined }).success).toBe(false);
    expect(LoopJobRecordSchema.safeParse({ ...running, startedAt: undefined }).success).toBe(false);
    expect(LoopJobRecordSchema.safeParse({ ...running, endedAt: 9_700 }).success).toBe(false);
    expect(LoopJobRecordSchema.safeParse({ ...job, leaseOwnerId: "unexpected-owner" }).success).toBe(false);
    expect(LoopJobRecordSchema.safeParse({ ...job, status: "succeeded", endedAt: undefined }).success).toBe(false);
    expect(LoopJobRecordSchema.safeParse({ ...job, baseSha: "a".repeat(40) }).success).toBe(true);
    expect(LoopJobRecordSchema.safeParse({ ...job, resolvedHeadSha: "b".repeat(40) }).success).toBe(false);
    expect(LoopJobRecordSchema.safeParse({
      ...job,
      worktreePath: "/tmp/worktree",
      baseSha: "a".repeat(40),
      observedArtifacts: [{ path: "git:branch:legacy-artifact", status: "observed" }],
    }).success).toBe(false);
    expect(LoopJobRecordSchema.safeParse({
      ...job,
      worktreePath: "/tmp/worktree",
      worktreeBranchName: "archcode/loop/test/job",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "b".repeat(40),
    }).success).toBe(true);

    const checkpoint = {
      version: 1 as const,
      hitlId: "hitl-1",
      loopId: LOOP_ID,
      runId: "run-1",
      jobId: job.jobId,
      trigger: "on_pr" as const,
      intendedContinuation: "resume_run" as const,
    };
    const needsUser = {
      ...job,
      status: "needs_user" as const,
      endedAt: 9_700,
      blockedReason: "needs_user",
      blockedByHitlIds: ["hitl-1"],
      attentionStatus: "waiting_for_human" as const,
      resumeCheckpoint: checkpoint,
    };
    expect(LoopJobRecordSchema.safeParse(needsUser).success).toBe(true);
    expect(LoopJobRecordSchema.safeParse({ ...needsUser, resumeCheckpoint: undefined }).success).toBe(false);
  });

  test("coalesces pending duplicate dedupeKey and keeps merged event summaries", async () => {
    const clock = new FakeClock(10_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });

    const first = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:main",
      repoId: "test-owner/test-repo",
      branch: "main",
      priority: 1,
      eventSummary: { summary: "commit a", source: "local-git" },
    });
    clock.set(10_500);
    const second = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:main",
      repoId: "test-owner/test-repo",
      branch: "main",
      priority: 5,
      eventSummary: { summary: "commit b", source: "local-git" },
    });

    const jobs = await queue.list();
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, coalesced: true, rerunAfterCurrent: false });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobId).toBe(first.job.jobId);
    expect(jobs[0]?.queuedAt).toBe(10_000);
    expect(jobs[0]?.priority).toBe(5);
    expect(jobs[0]?.eventSummaries.map((entry) => entry.summary)).toEqual(["commit a", "commit b"]);
  });

  test("running duplicate sets rerunAfterCurrent once without unlimited pending jobs", async () => {
    const clock = new FakeClock(20_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const originalSha = "1".repeat(40);
    const updatedSha = "2".repeat(40);
    const { job } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_pr",
      subjectKey: "pr:test-owner/test-repo#7",
      baseSha: originalSha,
    });
    await queue.update(job.jobId, {
      status: "running",
      startedAt: 20_000,
      leaseExpiresAt: 50_000,
      leaseOwnerId: "test-incarnation",
      leaseToken: "test-lease",
      attempts: 1,
    });

    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_pr",
      subjectKey: "pr:test-owner/test-repo#7",
      baseSha: updatedSha,
      eventSummary: { summary: "PR updated" },
    });
    await queue.enqueue({ loopId: LOOP_ID, triggerKind: "on_pr", subjectKey: "pr:test-owner/test-repo#7", eventSummary: { summary: "PR updated again" } });

    const jobs = await queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "running",
      rerunAfterCurrent: true,
      baseSha: originalSha,
      rerunInput: { baseSha: updatedSha },
    });
    expect(jobs[0]?.eventSummaries.map((entry) => entry.summary)).toEqual(["PR updated", "PR updated again"]);
  });

  test("keeps recovered execution input frozen before phase-two checkpoint", async () => {
    const clock = new FakeClock(25_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const oldBaseSha = "3".repeat(40);
    const newHeadSha = "4".repeat(40);
    const { job } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:recovered-before-worktree",
    });
    await queue.update(job.jobId, {
      status: "running",
      attempts: 1,
      startedAt: clock.now(),
      leaseExpiresAt: clock.now() + 60_000,
      leaseOwnerId: "old-process",
      leaseToken: "old-execution-token",
      baseSha: oldBaseSha,
    });
    const [recovered] = await queue.recoverRunningFromPriorIncarnation("new-process", clock.now() + 1);
    expect(recovered).toMatchObject({ status: "pending", attempts: 1, baseSha: oldBaseSha });
    expect(recovered?.worktreePath).toBeUndefined();

    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:recovered-before-worktree",
      baseSha: newHeadSha,
      eventSummary: { summary: "new commit after recovery", payloadSha: newHeadSha },
    });

    expect(await queue.read(job.jobId)).toMatchObject({
      status: "pending",
      attempts: 1,
      baseSha: oldBaseSha,
      rerunAfterCurrent: true,
      rerunInput: { baseSha: newHeadSha },
    });
  });

  test("derives exact dedupe, branch, and collision keys", async () => {
    const target = { type: "branch" as const, owner: "test-owner", repo: "test-repo", branch: "feature/queue" };
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(30_000) });

    const { job } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:feature/queue",
      repoId: "test-owner/test-repo",
      branch: "feature/queue",
      collisionTarget: target,
    });

    expect(job.subjectKey).toBe("branch:feature/queue");
    expect(job.dedupeKey).toBe(`${LOOP_ID}:on_commit:branch:feature/queue`);
    expect(job.branchKey).toBe("test-owner/test-repo:feature/queue");
    expect(job.collisionKey).toBe(canonicalTargetKey(target));
  });

  test("updates and removes jobs durably", async () => {
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(40_000) });
    const { job } = await queue.enqueue({ loopId: LOOP_ID, triggerKind: "manual", subjectKey: "manual:architect" });

    const blocked = await queue.update(job.jobId, { status: "blocked", blockedReason: "canonical checkout is dirty" });
    const removed = await queue.remove(blocked.jobId);

    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "canonical checkout is dirty" });
    expect(removed?.jobId).toBe(job.jobId);
    expect(await queue.list()).toEqual([]);
  });

  test("conditional control-plane updates cannot overwrite a newer dispatch token", async () => {
    const clock = new FakeClock(45_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const { job: pending } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "manual",
      subjectKey: "manual:stale-control-plane",
    });
    const running = await queue.claimNextReady({
      maxConcurrent: 1,
      leaseOwnerId: "current-process",
      leaseToken: "current-dispatch-token",
      startedAt: 45_001,
      leaseExpiresAt: 75_001,
    });

    const staleCancel = await queue.updateIfCurrent(pending.jobId, pending, {
      status: "cancelled",
      leaseOwnerId: undefined,
      leaseToken: undefined,
    });

    expect(staleCancel).toMatchObject({ outcome: "condition_mismatch" });
    expect(await queue.read(pending.jobId)).toMatchObject({
      status: "running",
      attempts: 1,
      leaseOwnerId: running?.leaseOwnerId,
      leaseToken: running?.leaseToken,
    });
  });

  test("conditional control-plane updates compare the durable record revision", async () => {
    const clock = new FakeClock(46_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const { job: staleSnapshot } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "manual",
      subjectKey: "manual:stale-revision",
    });
    clock.set(46_001);
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "manual",
      subjectKey: "manual:stale-revision",
      priority: 10,
      eventSummary: { summary: "coalesced newer input" },
    });

    const staleUpdate = await queue.updateIfCurrent(staleSnapshot.jobId, staleSnapshot, {
      status: "cancelled",
      blockedReason: "cancelled_by_user",
    });

    expect(staleUpdate).toMatchObject({ outcome: "condition_mismatch" });
    expect(await queue.read(staleSnapshot.jobId)).toMatchObject({
      status: "pending",
      priority: 10,
      updatedAt: 46_001,
    });
  });

  test("atomically finishes the owned dispatch and materializes its coalesced rerun", async () => {
    const clock = new FakeClock(47_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const oldHead = "a".repeat(40);
    const newHead = "b".repeat(40);
    const { job } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:atomic-finish",
      baseSha: oldHead,
    });
    const running = await queue.claimNextReady({
      maxConcurrent: 1,
      leaseOwnerId: "atomic-finish-process",
      leaseToken: "atomic-finish-token",
      startedAt: 47_001,
      leaseExpiresAt: 77_001,
    });
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:atomic-finish",
      baseSha: newHead,
      eventSummary: { summary: "new commit while dispatch is running" },
    });

    const result = await queue.finishClaimedRunning(
      job.jobId,
      { leaseOwnerId: running!.leaseOwnerId!, leaseToken: running!.leaseToken! },
      {
        status: "succeeded",
        endedAt: 47_002,
        leaseExpiresAt: undefined,
        leaseOwnerId: undefined,
        leaseToken: undefined,
      },
      { summary: "queued atomic rerun", source: "loop-coordinator" },
      47_002,
    );

    expect(result.outcome).toBe("updated");
    if (result.outcome !== "updated") throw new Error("Expected owned finish");
    expect(result.updated).toMatchObject({ status: "succeeded", baseSha: oldHead });
    expect(result.updated.rerunAfterCurrent).toBeUndefined();
    expect(result.updated.rerunInput).toBeUndefined();
    expect(result.rerun).toMatchObject({ status: "pending", baseSha: newHead, attempts: 0 });
    expect(result.rerun?.worktreePath).toBeUndefined();
    expect((await queue.list()).map((entry) => entry.status)).toEqual(["succeeded", "pending"]);
  });

  test("stale finish token cannot update the job or materialize a rerun", async () => {
    const clock = new FakeClock(48_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const { job } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:stale-atomic-finish",
    });
    const first = await queue.claimNextReady({
      maxConcurrent: 1,
      leaseOwnerId: "stale-finish-process",
      leaseToken: "stale-token",
      startedAt: 48_001,
      leaseExpiresAt: 78_001,
    });
    await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:stale-atomic-finish",
      baseSha: "c".repeat(40),
    });
    await queue.updateClaimedRunning(job.jobId, {
      leaseOwnerId: first!.leaseOwnerId!,
      leaseToken: first!.leaseToken!,
    }, {
      status: "pending",
      startedAt: undefined,
      leaseExpiresAt: undefined,
      leaseOwnerId: undefined,
      leaseToken: undefined,
    });
    const second = await queue.claimNextReady({
      maxConcurrent: 1,
      leaseOwnerId: "stale-finish-process",
      leaseToken: "current-token",
      startedAt: 48_002,
      leaseExpiresAt: 78_002,
    });

    const result = await queue.finishClaimedRunning(
      job.jobId,
      { leaseOwnerId: "stale-finish-process", leaseToken: "stale-token" },
      { status: "failed", rerunAfterCurrent: undefined, rerunInput: undefined },
      { summary: "must not be queued" },
      48_003,
    );

    expect(result).toMatchObject({ outcome: "lease_mismatch" });
    expect(await queue.list()).toEqual([
      expect.objectContaining({
        jobId: job.jobId,
        status: "running",
        leaseToken: second?.leaseToken,
        rerunAfterCurrent: true,
      }),
    ]);
  });

  test("serializes concurrent enqueue mutations for the same queue file", async () => {
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(50_000) });

    await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      await queue.enqueue({ loopId: LOOP_ID, triggerKind: "cron", subjectKey: `cron:${index}` });
    }));

    expect(await queue.list()).toHaveLength(25);
    expect(__queueLockCountForTest()).toBe(0);
  });

  test("rejects symlinked queue roots that escape the workspace", async () => {
    const outsideArchcode = join(TMP_DIR, "..", "outside-queue-archcode");
    await mkdir(outsideArchcode, { recursive: true });
    await symlink(outsideArchcode, join(TMP_DIR, ".archcode"), "dir");

    await expect(new LoopJobQueue({ workspaceRoot: TMP_DIR }).enqueue({ loopId: LOOP_ID, triggerKind: "manual", subjectKey: "manual:escape" })).rejects.toBeInstanceOf(LoopJobQueueSecurityError);
    expect(await Bun.file(join(outsideArchcode, "loops", "job-queue.json")).exists()).toBe(false);

    await rm(join(TMP_DIR, ".archcode"), { force: true });
    const outsideLoops = join(TMP_DIR, "..", "outside-queue-loops");
    await mkdir(outsideLoops, { recursive: true });
    await mkdir(join(TMP_DIR, ".archcode"), { recursive: true });
    await symlink(outsideLoops, join(TMP_DIR, ".archcode", "loops"), "dir");

    await expect(new LoopJobQueue({ workspaceRoot: TMP_DIR }).enqueue({ loopId: LOOP_ID, triggerKind: "manual", subjectKey: "manual:escape-2" })).rejects.toBeInstanceOf(LoopJobQueueSecurityError);
    expect(await Bun.file(join(outsideLoops, "job-queue.json")).exists()).toBe(false);
  });

  test("rejects secret-like event summaries and blocked reasons", async () => {
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(60_000) });

    await expect(queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "manual",
      subjectKey: "manual:secret",
      eventSummary: { summary: "token=sk_test_1234567890abcdef" },
    })).rejects.toBeInstanceOf(LoopJobQueueSecurityError);

    const { job } = await queue.enqueue({ loopId: LOOP_ID, triggerKind: "manual", subjectKey: "manual:block" });
    await expect(queue.update(job.jobId, { status: "blocked", blockedReason: "password=mysecret123" })).rejects.toBeInstanceOf(LoopJobQueueSecurityError);
  });

  test("enforces queue caps and prunes oldest terminal jobs", async () => {
    const capped = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(70_000), maxJobs: 2 });
    await capped.enqueue({ loopId: LOOP_ID, triggerKind: "manual", subjectKey: "manual:one" });
    await capped.enqueue({ loopId: LOOP_ID, triggerKind: "manual", subjectKey: "manual:two" });

    await expect(capped.enqueue({ loopId: LOOP_ID, triggerKind: "manual", subjectKey: "manual:three" })).rejects.toBeInstanceOf(LoopJobQueueLimitError);

    await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(TMP_DIR, { recursive: true });
    const pruning = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(80_000), maxTerminalJobs: 1 });
    const first = await pruning.enqueue({ loopId: LOOP_ID, triggerKind: "manual", subjectKey: "manual:first" });
    const second = await pruning.enqueue({ loopId: LOOP_ID, triggerKind: "manual", subjectKey: "manual:second" });
    await pruning.update(first.job.jobId, { status: "succeeded", endedAt: 81_000 });
    await pruning.update(second.job.jobId, { status: "failed", endedAt: 82_000 });

    expect((await pruning.list()).map((job) => job.subjectKey)).toEqual(["manual:second"]);
  });
});
