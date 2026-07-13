import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HitlIdentity, HitlOwnerKey, HitlRecord, HitlResponse } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { createInMemoryLogger, silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { HitlService } from "./service";
import { ResumeCoordinator, type SessionHitlResumeAdapter } from "./resume-coordinator";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "resume-coordinator");
const WAIT_TIMEOUT_MS = 5_000;
const WAIT_INTERVAL_MS = 5;

describe("ResumeCoordinator", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("duplicate respond calls create one durable claim and one adapter invocation", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    let releaseAdapter!: () => void;
    const adapter = new RecordingSessionAdapter({
      waitForRelease: new Promise<void>((resolve) => {
        releaseAdapter = resolve;
      }),
    });
    const coordinator = new ResumeCoordinator({ hitl: fixture.service, adapters: { session: adapter } });
    const response: HitlResponse = { type: "question_answer", answers: ["yes"] };

    const [first, second] = await Promise.all([
      coordinator.respond(identity(hitl), response),
      coordinator.respond(identity(hitl), response),
    ]);
    await waitFor(() => adapter.calls.length === 1);

    expect(first.status).toBe("claimed");
    expect(first.scheduled).toBe(true);
    expect(second.status).toBe("claimed");
    expect(second.scheduled).toBe(false);
    const firstRecord = resultRecord(first);
    const secondRecord = resultRecord(second);
    expect(secondRecord).toMatchObject({
      hitlId: hitl.hitlId,
      status: "resume_claimed",
      response,
      resume: { intent: "respond", attempt: 1 },
    });
    expect(secondRecord.resume?.claimId).toBe(firstRecord.resume?.claimId);
    expect(adapter.calls).toHaveLength(1);

    releaseAdapter();
    await waitForLookup(fixture.service, hitl, "resolved");
    expect(adapter.calls).toHaveLength(1);
  });

  test("acquires Session runtime ownership before publishing the durable resume claim", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    let finishAcquire!: () => void;
    const adapter = new RecordingSessionAdapter({
      waitForAcquire: new Promise<void>((resolve) => {
        finishAcquire = resolve;
      }),
    });
    const coordinator = new ResumeCoordinator({ hitl: fixture.service, adapters: { session: adapter } });

    const responding = coordinator.respond(identity(hitl), { type: "question_answer", answers: ["continue"] });
    await waitFor(() => adapter.acquisitions.length === 1);
    expect((await fixture.service.lookup(identity(hitl)))).toMatchObject({
      status: "found",
      record: { status: "pending" },
    });

    finishAcquire();
    await expect(responding).resolves.toMatchObject({ status: "claimed", scheduled: true });
    await waitForLookup(fixture.service, hitl, "resolved");
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.releaseCount).toBe(1);
  });

  test("same hitlId under different owners uses independent locks and dispatches", async () => {
    const fixture = await createFixture();
    const secondSessionId = crypto.randomUUID();
    fixture.sessions.create(secondSessionId, fixture.workspaceRoot, { agentName: "engineer" });
    await waitForSession(fixture.workspaceRoot, secondSessionId);
    const secondOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: secondSessionId };
    const hitlId = "shared-owner-local-id";
    const first = await fixture.service.create({
      owner: fixture.owner,
      sessionRootId: fixture.sessionId,
      hitlId,
      blockingKey: "first-owner-block",
      source: { type: "ask_user", sessionId: fixture.owner.ownerId },
      displayPayload: { title: "First owner", redacted: true },
    });
    const second = await fixture.service.create({
      owner: secondOwner,
      sessionRootId: secondSessionId,
      hitlId,
      blockingKey: "second-owner-block",
      source: { type: "ask_user", sessionId: secondOwner.ownerId },
      displayPayload: { title: "Second owner", redacted: true },
    });
    const adapter = new RecordingSessionAdapter();
    const coordinator = new ResumeCoordinator({ hitl: fixture.service, adapters: { session: adapter } });

    const [firstResult, secondResult] = await Promise.all([
      coordinator.respond(identity(first), { type: "question_answer", answers: ["first"] }),
      coordinator.respond(identity(second), { type: "question_answer", answers: ["second"] }),
    ]);

    expect(firstResult).toMatchObject({ status: "claimed", scheduled: true });
    expect(secondResult).toMatchObject({ status: "claimed", scheduled: true });
    await waitFor(() => adapter.calls.length === 2);
    expect(adapter.calls.map((record) => record.owner.ownerId).sort()).toEqual([
      fixture.owner.ownerId,
      secondOwner.ownerId,
    ].sort());
    await waitForLookup(fixture.service, first, "resolved");
    await waitForLookup(fixture.service, second, "resolved");
  });

  test("cancel after respond does not mutate the original respond claim", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    let releaseAdapter!: () => void;
    const adapter = new RecordingSessionAdapter({ waitForRelease: new Promise<void>((resolve) => { releaseAdapter = resolve; }) });
    const coordinator = new ResumeCoordinator({ hitl: fixture.service, adapters: { session: adapter } });

    const claimed = await coordinator.respond(identity(hitl), { type: "question_answer", answers: ["go"] });
    const cancelled = await coordinator.cancel(identity(hitl), "never mind");

    expect(claimed.status).toBe("claimed");
    expect(cancelled.status).toBe("claimed");
    expect(resultRecord(cancelled).response).toEqual({ type: "question_answer", answers: ["go"] });
    expect(resultRecord(cancelled).resume).toMatchObject({ intent: "respond", attempt: 1, claimId: resultRecord(claimed).resume?.claimId });

    releaseAdapter();
    const terminal = await waitForLookup(fixture.service, hitl, "resolved");
    expect(terminal.response).toEqual({ type: "question_answer", answers: ["go"] });
    expect(adapter.calls).toHaveLength(1);
  });

  test("respond after cancel does not mutate the original cancel claim", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    let releaseAdapter!: () => void;
    const adapter = new RecordingSessionAdapter({ waitForRelease: new Promise<void>((resolve) => { releaseAdapter = resolve; }) });
    const coordinator = new ResumeCoordinator({ hitl: fixture.service, adapters: { session: adapter } });

    const cancelled = await coordinator.cancel(identity(hitl), "user cancelled", "tester");
    const responded = await coordinator.respond(identity(hitl), { type: "question_answer", answers: ["late"] });

    expect(cancelled.status).toBe("claimed");
    expect(responded.status).toBe("claimed");
    expect(resultRecord(responded).response).toEqual({ type: "cancel", reason: "user cancelled", cancelledBy: "tester" });
    expect(resultRecord(responded).resume).toMatchObject({ intent: "cancel", attempt: 1, claimId: resultRecord(cancelled).resume?.claimId });

    releaseAdapter();
    const terminal = await waitForLookup(fixture.service, hitl, "cancelled");
    expect(terminal.response).toEqual({ type: "cancel", reason: "user cancelled", cancelledBy: "tester" });
    expect(adapter.calls).toHaveLength(1);
  });

  test("restart recovery leaves plain pending HITL pending and displayable", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    const adapter = new RecordingSessionAdapter();
    const reloaded = await createFixture(fixture.workspaceRoot, fixture.sessions, fixture.sessionId);
    const coordinator = new ResumeCoordinator({ hitl: reloaded.service, adapters: { session: adapter } });

    const summary = await coordinator.recover();
    const lookup = await reloaded.service.lookup(identity(hitl));
    const projections = await reloaded.service.list({ scope: "project" });

    expect(summary).toMatchObject({ scanned: 1, scheduled: 0, skippedPending: 1 });
    expect(lookup).toMatchObject({ status: "found", record: { hitlId: hitl.hitlId, status: "pending" } });
    expect(projections).toContainEqual(expect.objectContaining({
      hitlId: hitl.hitlId,
      status: "pending",
      displayPayload: { title: "Need answer", redacted: true },
    }));
    expect(adapter.calls).toHaveLength(0);
  });

  test("restart recovery invokes the correct adapter once for resume_claimed HITL", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    const response: HitlResponse = { type: "question_answer", answers: ["after restart"] };
    const claimed = await (await fixture.service.ownerStore(hitl.owner)).claim(hitl.hitlId, response, {
      claimId: "persisted-claim",
      claimedAt: new Date().toISOString(),
      intent: "respond",
      attempt: 1,
    });
    const adapter = new RecordingSessionAdapter();
    const reloaded = await createFixture(fixture.workspaceRoot, fixture.sessions, fixture.sessionId);
    const coordinator = new ResumeCoordinator({ hitl: reloaded.service, adapters: { session: adapter } });

    const [first, second] = await Promise.all([coordinator.recover(), coordinator.recover()]);
    await waitForLookup(reloaded.service, hitl, "resolved");

    expect(first.scheduled + second.scheduled).toBe(1);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toMatchObject({
      hitlId: claimed.hitlId,
      status: "resume_claimed",
      resume: { claimId: "persisted-claim", attempt: 1, intent: "respond" },
      response,
    });
  });

  test("restart recovery schedules a claimed resume without waiting for its adapter tail", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    const response: HitlResponse = { type: "question_answer", answers: ["continue in background"] };
    await (await fixture.service.ownerStore(hitl.owner)).claim(hitl.hitlId, response, {
      claimId: "persisted-background-claim",
      claimedAt: new Date().toISOString(),
      intent: "respond",
      attempt: 1,
    });
    let releaseAdapter!: () => void;
    const adapter = new RecordingSessionAdapter({
      waitForRelease: new Promise<void>((resolve) => { releaseAdapter = resolve; }),
    });
    const reloaded = await createFixture(fixture.workspaceRoot, fixture.sessions, fixture.sessionId);
    const coordinator = new ResumeCoordinator({ hitl: reloaded.service, adapters: { session: adapter } });

    const recovery = coordinator.recover();
    const recoveredBeforeAdapterTail = await Promise.race([
      recovery.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    const claimedDuringTail = await reloaded.service.lookup(identity(hitl));
    releaseAdapter();
    const summary = await recovery;

    expect(recoveredBeforeAdapterTail).toBe(true);
    expect(summary.scheduled).toBe(1);
    expect(claimedDuringTail).toMatchObject({
      status: "found",
      record: { status: "resume_claimed", resume: { claimId: "persisted-background-claim" } },
    });
    await waitForLookup(reloaded.service, hitl, "resolved");
  });

  test("partial adapter recovery durably fails claimed owner types without a matching adapter", async () => {
    const fixture = await createFixture();
    const sessionHitl = await fixture.createSessionHitl();
    const goal = await fixture.goalState.commit({
      id: crypto.randomUUID(),
      projectId: "archcode",
      createdFromSessionId: crypto.randomUUID(),
      objective: "Wait for a future Goal adapter.",
      acceptanceCriteria: "Claimed Goal HITL records a durable resume failure when no adapter exists.",
      mainSessionId: crypto.randomUUID(),
    });
    const goalOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "goal", ownerId: goal.id };
    const goalHitl = await fixture.service.create({
      owner: goalOwner,
      blockingKey: `goal:${goal.id}:approval:after_plan`,
      source: { type: "goal_approval", goalId: goal.id, approvalPoint: "after_plan", resumeStatus: "running" },
      displayPayload: { title: "Approve goal", redacted: true },
    });
    const sessionResponse: HitlResponse = { type: "question_answer", answers: ["session resumes"] };
    const goalResponse: HitlResponse = { type: "approval_decision", decision: "approved", comment: "future goal adapter" };
    await (await fixture.service.ownerStore(sessionHitl.owner)).claim(sessionHitl.hitlId, sessionResponse, {
      claimId: "session-claim",
      claimedAt: new Date().toISOString(),
      intent: "respond",
      attempt: 1,
    });
    await (await fixture.service.ownerStore(goalOwner)).claim(goalHitl.hitlId, goalResponse, {
      claimId: "goal-claim",
      claimedAt: new Date().toISOString(),
      intent: "respond",
      attempt: 1,
    });
    const adapter = new RecordingSessionAdapter();
    const reloaded = await createFixture(fixture.workspaceRoot, fixture.sessions, fixture.sessionId);
    const coordinator = new ResumeCoordinator({ hitl: reloaded.service, adapters: { session: adapter } });

    const summary = await coordinator.recover();
    const resolvedSession = await waitForLookup(reloaded.service, sessionHitl, "resolved");
    const failedGoal = await waitForLookup(reloaded.service, goalHitl, "resume_failed");

    expect(summary.scheduled).toBe(2);
    expect(adapter.calls).toHaveLength(1);
    expect(resolvedSession.response).toEqual(sessionResponse);
    expect(failedGoal).toMatchObject({
      hitlId: goalHitl.hitlId,
      status: "resume_failed",
      response: goalResponse,
      resume: {
        claimId: "goal-claim",
        intent: "respond",
        attempt: 1,
        lastError: "No HITL resume adapter registered for goal owner",
      },
    });
  });

  test("adapter failure leaves resume_failed active and recovery can retry it", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    const failing = new RecordingSessionAdapter({ failWith: new Error("adapter offline") });
    const coordinator = new ResumeCoordinator({ hitl: fixture.service, adapters: { session: failing } });

    const claimed = await coordinator.respond(identity(hitl), { type: "question_answer", answers: ["retry later"] });
    const failed = await waitForLookup(fixture.service, hitl, "resume_failed");

    expect(claimed.status).toBe("claimed");
    expect(failing.calls).toHaveLength(1);
    expect(failed).toMatchObject({
      status: "resume_failed",
      resume: { claimId: resultRecord(claimed).resume?.claimId, intent: "respond", attempt: 1, lastError: "adapter offline" },
    });

    const recovering = new RecordingSessionAdapter();
    const reloaded = await createFixture(fixture.workspaceRoot, fixture.sessions, fixture.sessionId);
    const recoveryCoordinator = new ResumeCoordinator({ hitl: reloaded.service, adapters: { session: recovering } });

    const summary = await recoveryCoordinator.recover();
    const terminal = await waitForLookup(reloaded.service, hitl, "resolved");

    expect(summary.scheduled).toBe(1);
    expect(recovering.calls).toHaveLength(1);
    expect(recovering.calls[0]?.resume).toMatchObject({ intent: "respond", attempt: 2 });
    expect(recovering.calls[0]?.resume?.claimId).not.toBe(resultRecord(claimed).resume?.claimId);
    expect(terminal.status).toBe("resolved");
  });

  test("background recovery observes a secondary resume-failure persistence rejection", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    await (await fixture.service.ownerStore(hitl.owner)).claim(
      hitl.hitlId,
      { type: "question_answer", answers: ["retry"] },
      {
        claimId: "persist-failure-claim",
        claimedAt: new Date().toISOString(),
        intent: "respond",
        attempt: 1,
      },
    );
    const service = new ResumeFailurePersistenceHitlService({
      workspaceRoot: fixture.workspaceRoot,
      project: { slug: "archcode", name: "ArchCode" },
      sessions: fixture.sessions,
      goalState: fixture.goalState,
    });
    const { logger, entries } = createInMemoryLogger();
    const coordinator = new ResumeCoordinator({
      hitl: service,
      adapters: { session: new RecordingSessionAdapter({ failWith: new Error("adapter failed") }) },
      logger,
    });

    expect((await coordinator.recover()).scheduled).toBe(1);
    await waitFor(() => entries.some((entry) => entry.event === "hitl.resume.dispatch.failed"));

    expect(entries).toContainEqual(expect.objectContaining({
      level: "error",
      event: "hitl.resume.dispatch.failed",
      context: expect.objectContaining({ hitlId: hitl.hitlId, claimId: "persist-failure-claim" }),
    }));
  });
});

class ResumeFailurePersistenceHitlService extends HitlService {
  override async markResumeFailed(): Promise<undefined> {
    throw new Error("resume failure persistence unavailable");
  }
}

class RecordingSessionAdapter implements SessionHitlResumeAdapter {
  readonly calls: HitlRecord[] = [];
  readonly acquisitions: HitlRecord[] = [];
  releaseCount = 0;

  constructor(
    private readonly options: {
      readonly waitForRelease?: Promise<void>;
      readonly waitForAcquire?: Promise<void>;
      readonly failWith?: Error;
    } = {},
  ) {}

  async prepare(record: HitlRecord, _response: HitlResponse) {
    this.acquisitions.push(structuredClone(record));
    await this.options.waitForAcquire;
    let released = false;
    return {
      run: async (claimedRecord: HitlRecord, _claimedResponse: HitlResponse): Promise<void> => {
        this.calls.push(structuredClone(claimedRecord));
        await this.options.waitForRelease;
        if (this.options.failWith !== undefined) throw this.options.failWith;
      },
      release: () => {
        if (released) return;
        released = true;
        this.releaseCount += 1;
      },
    };
  }
}

function resultRecord(result: Awaited<ReturnType<ResumeCoordinator["respond"]>>): HitlRecord {
  if (!("record" in result)) throw new Error(`Expected record result, got ${result.status}`);
  return result.record;
}

async function createFixture(workspaceRoot?: string, sessions = new SessionStoreManager({ logger: silentLogger }), sessionId = crypto.randomUUID()) {
  workspaceRoot ??= await mkdtemp(join(TMP_ROOT, "workspace-"));
  sessions.create(sessionId, workspaceRoot, { agentName: "engineer" });
  await waitForSession(workspaceRoot, sessionId);
  const goalState = new GoalStateManager(workspaceRoot, silentLogger);
  const service = new HitlService({
    workspaceRoot,
    project: { slug: "archcode", name: "ArchCode" },
    sessions,
    goalState,
  });
  const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: sessionId };
  return {
    service,
    workspaceRoot,
    sessions,
    sessionId,
    goalState,
    owner,
    createSessionHitl: () => service.create({
      owner,
      sessionRootId: sessionId,
      blockingKey: `session:${sessionId}:ask:test`,
      source: { type: "ask_user", sessionId, toolCallId: "test" },
      displayPayload: { title: "Need answer", redacted: true },
    }),
  };
}

async function waitForLookup(
  service: HitlService,
  record: Pick<HitlRecord, "owner" | "hitlId">,
  status: HitlRecord["status"],
): Promise<HitlRecord> {
  let latest: HitlRecord | undefined;
  await waitFor(async () => {
    const lookup = await service.lookup(identity(record));
    latest = lookup.status === "found" ? lookup.record : undefined;
    return latest?.status === status;
  }, () => `expected HITL ${record.hitlId} to become ${status}, last status was ${latest?.status ?? "missing"}`);
  return latest!;
}

function identity(record: Pick<HitlRecord, "owner" | "hitlId">): HitlIdentity {
  return { owner: record.owner, hitlId: record.hitlId };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message?: string | (() => string)): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  const details = typeof message === "function" ? message() : message;
  const suffix = details === undefined ? "" : `: ${details}`;
  if (lastError !== undefined) {
    throw new Error(`condition was not met${suffix}; last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  throw new Error(`condition was not met${suffix}`);
}

async function waitForSession(workspaceRoot: string, sessionId: string): Promise<void> {
  const path = join(workspaceRoot, ".archcode", "sessions", sessionId, "session.json");
  await waitFor(async () => await Bun.file(path).exists(), `session was not persisted: ${sessionId}`);
}
