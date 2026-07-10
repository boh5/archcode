import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HitlOwnerKey, HitlRecord, HitlResponse } from "@archcode/protocol";

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
      coordinator.respond(hitl.hitlId, response),
      coordinator.respond(hitl.hitlId, response),
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
    await waitForLookup(fixture.service, hitl.hitlId, "resolved");
    expect(adapter.calls).toHaveLength(1);
  });

  test("cancel after respond does not mutate the original respond claim", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    let releaseAdapter!: () => void;
    const adapter = new RecordingSessionAdapter({ waitForRelease: new Promise<void>((resolve) => { releaseAdapter = resolve; }) });
    const coordinator = new ResumeCoordinator({ hitl: fixture.service, adapters: { session: adapter } });

    const claimed = await coordinator.respond(hitl.hitlId, { type: "question_answer", answers: ["go"] });
    const cancelled = await coordinator.cancel(hitl.hitlId, "never mind");

    expect(claimed.status).toBe("claimed");
    expect(cancelled.status).toBe("claimed");
    expect(resultRecord(cancelled).response).toEqual({ type: "question_answer", answers: ["go"] });
    expect(resultRecord(cancelled).resume).toMatchObject({ intent: "respond", attempt: 1, claimId: resultRecord(claimed).resume?.claimId });

    releaseAdapter();
    const terminal = await waitForLookup(fixture.service, hitl.hitlId, "resolved");
    expect(terminal.response).toEqual({ type: "question_answer", answers: ["go"] });
    expect(adapter.calls).toHaveLength(1);
  });

  test("respond after cancel does not mutate the original cancel claim", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    let releaseAdapter!: () => void;
    const adapter = new RecordingSessionAdapter({ waitForRelease: new Promise<void>((resolve) => { releaseAdapter = resolve; }) });
    const coordinator = new ResumeCoordinator({ hitl: fixture.service, adapters: { session: adapter } });

    const cancelled = await coordinator.cancel(hitl.hitlId, "user cancelled", "tester");
    const responded = await coordinator.respond(hitl.hitlId, { type: "question_answer", answers: ["late"] });

    expect(cancelled.status).toBe("claimed");
    expect(responded.status).toBe("claimed");
    expect(resultRecord(responded).response).toEqual({ type: "cancel", reason: "user cancelled", cancelledBy: "tester" });
    expect(resultRecord(responded).resume).toMatchObject({ intent: "cancel", attempt: 1, claimId: resultRecord(cancelled).resume?.claimId });

    releaseAdapter();
    const terminal = await waitForLookup(fixture.service, hitl.hitlId, "cancelled");
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
    const lookup = await reloaded.service.lookup(hitl.hitlId);
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
    await waitForLookup(reloaded.service, hitl.hitlId, "resolved");

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
    const claimedDuringTail = await reloaded.service.lookup(hitl.hitlId);
    releaseAdapter();
    const summary = await recovery;

    expect(recoveredBeforeAdapterTail).toBe(true);
    expect(summary.scheduled).toBe(1);
    expect(claimedDuringTail).toMatchObject({
      status: "found",
      record: { status: "resume_claimed", resume: { claimId: "persisted-background-claim" } },
    });
    await waitForLookup(reloaded.service, hitl.hitlId, "resolved");
  });

  test("partial adapter recovery skips claimed owner types without a matching adapter", async () => {
    const fixture = await createFixture();
    const sessionHitl = await fixture.createSessionHitl();
    const goal = await fixture.goalState.create({
      projectId: "archcode",
      objective: "Wait for a future Goal adapter.",
      acceptanceCriteria: "Claimed Goal HITL remains queued when no adapter exists.",
    });
    const goalOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "goal", ownerId: goal.id };
    const goalHitl = await fixture.service.create({
      owner: goalOwner,
      blockingKey: `goal:${goal.id}:approval:after_plan`,
      source: { type: "goal_approval", goalId: goal.id, approvalPoint: "after_plan" },
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
    const resolvedSession = await waitForLookup(reloaded.service, sessionHitl.hitlId, "resolved");
    const goalLookup = await reloaded.service.lookup(goalHitl.hitlId);

    expect(summary.scheduled).toBe(1);
    expect(adapter.calls).toHaveLength(1);
    expect(resolvedSession.response).toEqual(sessionResponse);
    expect(goalLookup).toMatchObject({
      status: "found",
      record: {
        hitlId: goalHitl.hitlId,
        status: "resume_claimed",
        response: goalResponse,
        resume: { claimId: "goal-claim", intent: "respond", attempt: 1 },
      },
    });
  });

  test("adapter failure leaves resume_failed active and recovery can retry it", async () => {
    const fixture = await createFixture();
    const hitl = await fixture.createSessionHitl();
    const failing = new RecordingSessionAdapter({ failWith: new Error("adapter offline") });
    const coordinator = new ResumeCoordinator({ hitl: fixture.service, adapters: { session: failing } });

    const claimed = await coordinator.respond(hitl.hitlId, { type: "question_answer", answers: ["retry later"] });
    const failed = await waitForLookup(fixture.service, hitl.hitlId, "resume_failed");

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
    const terminal = await waitForLookup(reloaded.service, hitl.hitlId, "resolved");

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
    await service.load(fixture.workspaceRoot);
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

  constructor(
    private readonly options: {
      readonly waitForRelease?: Promise<void>;
      readonly failWith?: Error;
    } = {},
  ) {}

  async resume(record: HitlRecord, _response: HitlResponse): Promise<void> {
    this.calls.push(structuredClone(record));
    await this.options.waitForRelease;
    if (this.options.failWith !== undefined) throw this.options.failWith;
  }
}

function resultRecord(result: Awaited<ReturnType<ResumeCoordinator["respond"]>>): HitlRecord {
  if (!("record" in result)) throw new Error(`Expected record result, got ${result.status}`);
  return result.record;
}

async function createFixture(workspaceRoot?: string, sessions = new SessionStoreManager({ logger: silentLogger }), sessionId = crypto.randomUUID()) {
  workspaceRoot ??= await mkdtemp(join(TMP_ROOT, "workspace-"));
  sessions.create(sessionId, workspaceRoot);
  await waitForSession(workspaceRoot, sessionId);
  const goalState = new GoalStateManager(workspaceRoot, silentLogger);
  const service = new HitlService({
    workspaceRoot,
    project: { slug: "archcode", name: "ArchCode" },
    sessions,
    goalState,
  });
  await service.load(workspaceRoot);
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
      blockingKey: `session:${sessionId}:ask:test`,
      source: { type: "ask_user", sessionId, toolCallId: "test" },
      displayPayload: { title: "Need answer", redacted: true },
    }),
  };
}

async function waitForLookup(service: HitlService, hitlId: string, status: HitlRecord["status"]): Promise<HitlRecord> {
  let latest: HitlRecord | undefined;
  await waitFor(async () => {
    const lookup = await service.lookup(hitlId);
    latest = lookup.status === "found" ? lookup.record : undefined;
    return latest?.status === status;
  }, () => `expected HITL ${hitlId} to become ${status}, last status was ${latest?.status ?? "missing"}`);
  return latest!;
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
