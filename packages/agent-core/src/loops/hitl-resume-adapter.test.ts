import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HitlRecord, LoopHitlCheckpoint } from "@archcode/protocol";

import { LoopJobQueue, type LoopJobRecord } from "./job-queue";
import { LoopHitlResumeAdapter } from "./hitl-resume-adapter";
import { LoopStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "hitl-resume-adapter");

describe("LoopHitlResumeAdapter recovery", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("missing job rejects without clearing the durable Loop blocker", async () => {
    const fixture = await createBlockedFixture();
    await fixture.jobQueue.remove(fixture.job.jobId);

    await expect(fixture.adapter.resume(fixture.record, approvedResponse())).rejects.toThrow("not found");

    const state = await fixture.stateManager.read(fixture.loopId);
    expect(state.attentionStatus).toBe("waiting_for_human");
    expect(state.resumeCheckpoint?.hitlId).toBe(fixture.record.hitlId);
  });

  test("unexpected job state rejects without clearing the durable Loop blocker", async () => {
    const fixture = await createBlockedFixture();
    await fixture.jobQueue.update(fixture.job.jobId, {
      status: "running",
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
      resumeCheckpoint: undefined,
    });

    await expect(fixture.adapter.resume(fixture.record, approvedResponse())).rejects.toThrow("unexpected");

    const state = await fixture.stateManager.read(fixture.loopId);
    expect(state.attentionStatus).toBe("waiting_for_human");
    expect(state.resumeCheckpoint?.hitlId).toBe(fixture.record.hitlId);
  });

  test("recovers a cleared Loop state from the blocked job checkpoint", async () => {
    const fixture = await createBlockedFixture({ recordStateBlocker: false });

    await fixture.adapter.resume(fixture.record, approvedResponse());

    expect(await fixture.jobQueue.read(fixture.job.jobId)).toMatchObject({
      status: "pending",
      attentionStatus: "clear",
    });
    expect((await fixture.jobQueue.read(fixture.job.jobId)).resumeCheckpoint).toBeUndefined();
  });

  test("CAS mismatch succeeds only after rereading an equivalent committed continuation", async () => {
    const fixture = await createBlockedFixture();
    const queue = fixture.jobQueue;
    const mismatchQueue = {
      read: (jobId: string) => queue.read(jobId),
      list: () => queue.list(),
      updateIfCurrent: async (jobId: string, _expected: LoopJobRecord, updates: Partial<LoopJobRecord>) => {
        const committed = await queue.update(jobId, updates);
        return { outcome: "condition_mismatch" as const, job: committed };
      },
    };
    const adapter = new LoopHitlResumeAdapter({
      workspaceRoot: fixture.workspaceRoot,
      stateManager: fixture.stateManager,
      jobQueue: mismatchQueue as unknown as LoopJobQueue,
    });

    await adapter.resume(fixture.record, approvedResponse());

    expect((await fixture.stateManager.read(fixture.loopId)).attentionStatus).toBe("clear");
    expect((await queue.read(fixture.job.jobId)).status).toBe("pending");
  });

  test("CAS mismatch with divergent job state throws and preserves the Loop blocker", async () => {
    const fixture = await createBlockedFixture();
    const queue = fixture.jobQueue;
    const mismatchQueue = {
      read: (jobId: string) => queue.read(jobId),
      list: () => queue.list(),
      updateIfCurrent: async (jobId: string) => {
        const divergent = await queue.update(jobId, {
          status: "running",
          blockedByHitlIds: undefined,
          attentionStatus: "clear",
          resumeCheckpoint: undefined,
        });
        return { outcome: "condition_mismatch" as const, job: divergent };
      },
    };
    const adapter = new LoopHitlResumeAdapter({
      workspaceRoot: fixture.workspaceRoot,
      stateManager: fixture.stateManager,
      jobQueue: mismatchQueue as unknown as LoopJobQueue,
    });

    await expect(adapter.resume(fixture.record, approvedResponse())).rejects.toThrow("CAS");

    expect((await fixture.stateManager.read(fixture.loopId)).attentionStatus).toBe("waiting_for_human");
  });

  test("terminal response validates the job before finishing Loop state", async () => {
    const fixture = await createBlockedFixture();
    await fixture.jobQueue.update(fixture.job.jobId, {
      status: "running",
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
      resumeCheckpoint: undefined,
    });

    await expect(fixture.adapter.resume(fixture.record, {
      type: "approval_decision",
      decision: "denied",
      comment: "not now",
    })).rejects.toThrow("unexpected");

    expect((await fixture.stateManager.read(fixture.loopId)).currentRun?.status).toBe("needs_user");
  });

  test("terminal retry clears the blocker after the job and run committed before a crash", async () => {
    const fixture = await createBlockedFixture();
    const reason = "not now";
    const blockedState = await fixture.stateManager.read(fixture.loopId);
    const blockedRun = blockedState.currentRun!;
    await fixture.jobQueue.update(fixture.job.jobId, {
      status: "skipped",
      blockedReason: reason,
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
      resumeCheckpoint: undefined,
      leaseExpiresAt: undefined,
      leaseOwnerId: undefined,
      leaseToken: undefined,
      endedAt: 1_000,
      updatedAt: 1_000,
    });
    await fixture.stateManager.recordRunFinish(fixture.loopId, {
      ...blockedRun,
      status: "skipped",
      endedAt: 1_000,
      skippedReason: reason,
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
      resumeCheckpoint: undefined,
      summary: reason,
      error: undefined,
    });
    expect((await fixture.stateManager.read(fixture.loopId)).resumeCheckpoint?.hitlId).toBe(fixture.record.hitlId);

    await fixture.adapter.resume(fixture.record, {
      type: "approval_decision",
      decision: "denied",
      comment: reason,
    });

    const recovered = await fixture.stateManager.read(fixture.loopId);
    expect(recovered.lastRun?.status).toBe("skipped");
    expect(recovered.resumeCheckpoint).toBeUndefined();
    expect(recovered.blockedByHitlIds).toBeUndefined();
    expect(recovered.attentionStatus).toBe("clear");
  });
});

async function createBlockedFixture(options: { readonly recordStateBlocker?: boolean } = {}) {
  const workspaceRoot = join(TMP_ROOT, crypto.randomUUID());
  await mkdir(workspaceRoot, { recursive: true });
  const now = 1_000;
  const stateManager = new LoopStateManager(workspaceRoot);
  const state = await stateManager.create("project-a", {
    templateId: "watch_report",
    title: null,
    schedule: { kind: "manual" },
    approvalPolicy: "explicit_per_run",
    limits: { maxIterationsPerRun: 3 },
  });
  const jobQueue = new LoopJobQueue({ workspaceRoot, clock: { now: () => now } });
  const enqueued = await jobQueue.enqueue({
    loopId: state.loopId,
    triggerKind: "manual",
    subjectKey: `manual:${state.loopId}`,
  });
  const hitlId = crypto.randomUUID();
  const checkpoint: LoopHitlCheckpoint = {
    version: 1,
    hitlId,
    loopId: state.loopId,
    runId: "run-1",
    jobId: enqueued.job.jobId,
    trigger: "manual",
    subjectKey: enqueued.job.subjectKey,
    intendedContinuation: "rerun_job",
  };
  const job = await jobQueue.update(enqueued.job.jobId, {
    status: "needs_user",
    blockedReason: "needs_user",
    blockedByHitlIds: [hitlId],
    attentionStatus: "waiting_for_human",
    resumeCheckpoint: checkpoint,
  });
  if (options.recordStateBlocker !== false) {
    await stateManager.recordRunBlocked(state.loopId, {
      runId: checkpoint.runId,
      loopId: state.loopId,
      status: "needs_user",
      trigger: checkpoint.trigger,
      startedAt: now,
      endedAt: now,
      jobId: job.jobId,
      subjectKey: job.subjectKey,
      blockedReason: "needs_user",
      blockedByHitlIds: [hitlId],
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: checkpoint,
    });
  }
  const record: HitlRecord = {
    hitlId,
    owner: { projectSlug: "project-a", ownerType: "loop", ownerId: state.loopId },
    blockingKey: `loop:${state.loopId}:run:${checkpoint.runId}:approval`,
    source: { type: "loop_approval", loopId: state.loopId, approvalPoint: "explicit_per_run" },
    status: "resume_claimed",
    displayPayload: { title: "Approve loop", redacted: true },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  return {
    workspaceRoot,
    loopId: state.loopId,
    stateManager,
    jobQueue,
    job,
    record,
    adapter: new LoopHitlResumeAdapter({ workspaceRoot, stateManager, jobQueue, now: () => now }),
  };
}

function approvedResponse() {
  return { type: "approval_decision" as const, decision: "approved" as const };
}
