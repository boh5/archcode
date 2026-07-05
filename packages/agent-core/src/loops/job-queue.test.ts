import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { canonicalTargetKey } from "./collision-ledger";
import { LoopJobQueue, LoopJobQueueFileSchema, LoopJobQueueLimitError, LoopJobQueueSecurityError } from "./job-queue";
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
      if (status !== "pending") await queue.update(job.jobId, { status, startedAt: 2_000 + index });
    }

    const restarted = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(9_000) });
    expect((await restarted.list()).map((job) => job.status)).toEqual(statuses);

    const queuePath = await restarted.queuePath();
    const parsed = LoopJobQueueFileSchema.parse(JSON.parse(await Bun.file(queuePath).text()));
    expect(parsed.jobs).toHaveLength(statuses.length);
    expect((await readdir(join(TMP_DIR, ".archcode", "loops"))).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });

  test("coalesces pending duplicate dedupeKey and keeps merged event summaries", async () => {
    const clock = new FakeClock(10_000);
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });

    const first = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:main",
      repoId: "archcode/workbench",
      branch: "main",
      priority: 1,
      eventSummary: { summary: "commit a", source: "local-git" },
    });
    clock.set(10_500);
    const second = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:main",
      repoId: "archcode/workbench",
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
    const { job } = await queue.enqueue({ loopId: LOOP_ID, triggerKind: "on_pr", subjectKey: "pr:archcode/workbench#7" });
    await queue.update(job.jobId, { status: "running", startedAt: 20_000, leaseExpiresAt: 50_000, attempts: 1 });

    await queue.enqueue({ loopId: LOOP_ID, triggerKind: "on_pr", subjectKey: "pr:archcode/workbench#7", eventSummary: { summary: "PR updated" } });
    await queue.enqueue({ loopId: LOOP_ID, triggerKind: "on_pr", subjectKey: "pr:archcode/workbench#7", eventSummary: { summary: "PR updated again" } });

    const jobs = await queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "running", rerunAfterCurrent: true });
    expect(jobs[0]?.eventSummaries.map((entry) => entry.summary)).toEqual(["PR updated", "PR updated again"]);
  });

  test("derives exact dedupe, branch, and collision keys", async () => {
    const target = { type: "branch" as const, owner: "archcode", repo: "workbench", branch: "feature/queue" };
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(30_000) });

    const { job } = await queue.enqueue({
      loopId: LOOP_ID,
      triggerKind: "on_commit",
      subjectKey: "branch:feature/queue",
      repoId: "archcode/workbench",
      branch: "feature/queue",
      collisionTarget: target,
    });

    expect(job.subjectKey).toBe("branch:feature/queue");
    expect(job.dedupeKey).toBe(`${LOOP_ID}:on_commit:branch:feature/queue`);
    expect(job.branchKey).toBe("archcode/workbench:feature/queue");
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

  test("serializes concurrent enqueue mutations for the same queue file", async () => {
    const queue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock: new FakeClock(50_000) });

    await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      await queue.enqueue({ loopId: LOOP_ID, triggerKind: "cron", subjectKey: `cron:${index}` });
    }));

    expect(await queue.list()).toHaveLength(25);
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
