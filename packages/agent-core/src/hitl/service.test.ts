import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GlobalSSEHitlRealtimeEvent, HitlIdentity, HitlOwnerKey, HitlDeliveryMetadata } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { silentLogger, type Logger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionHitlPath } from "../store/sessions-dir";
import { HitlService, type HitlServiceOptions } from "./service";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "service", crypto.randomUUID());

describe("HitlService owner-local storage", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("creates Session and Goal HITL records beside their owners", async () => {
    const { service, workspaceRoot, goalState } = await createService();
    const sessionOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const goalOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "goal", ownerId: crypto.randomUUID() };

    await service.create(input(sessionOwner, "session-block"));
    await service.create(input(goalOwner, "goal-block"));

    expect(await Bun.file(getSessionHitlPath(workspaceRoot, sessionOwner.ownerId)).exists()).toBe(true);
    expect(await Bun.file(await goalState.goalHitlPath(goalOwner.ownerId)).exists()).toBe(true);
    expect(await Bun.file(join(workspaceRoot, ".archcode", "hitl-queue.json")).exists()).toBe(false);
  });

  test("owner-qualified identity keeps duplicate ids visible and mutations isolated", async () => {
    const { service, sessions, workspaceRoot } = await createService();
    const firstSession = crypto.randomUUID();
    const secondSession = crypto.randomUUID();
    sessions.create(firstSession, workspaceRoot, { agentName: "engineer" });
    sessions.create(secondSession, workspaceRoot, { agentName: "engineer" });
    await waitForSession(workspaceRoot, firstSession);
    await waitForSession(workspaceRoot, secondSession);

    const firstOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: firstSession };
    const secondOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: secondSession };
    await service.create({ ...input(firstOwner, "first"), hitlId: "duplicated-hitl" });
    await service.create({ ...input(secondOwner, "second"), hitlId: "duplicated-hitl" });

    const firstIdentity: HitlIdentity = { owner: firstOwner, hitlId: "duplicated-hitl" };
    const secondIdentity: HitlIdentity = { owner: secondOwner, hitlId: "duplicated-hitl" };

    expect(await service.lookup({ ...firstIdentity, hitlId: "missing-hitl" })).toEqual({ status: "missing" });
    expect(await service.lookup(firstIdentity)).toMatchObject({ status: "found", record: { owner: firstOwner } });
    expect(await service.lookup(secondIdentity)).toMatchObject({ status: "found", record: { owner: secondOwner } });
    expect((await service.list({ scope: "project" })).filter((projection) => projection.hitlId === "duplicated-hitl")).toHaveLength(2);

    await service.claim(firstIdentity, { type: "question_answer", answers: ["first"] }, claimMetadata("first-claim"));
    expect(await service.lookup(firstIdentity)).toMatchObject({ status: "found", record: { status: "answered" } });
    expect(await service.lookup(secondIdentity)).toMatchObject({ status: "found", record: { status: "pending" } });
  });

  test("construction rejects an incomplete project composition", async () => {
    const workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const incomplete = {
      workspaceRoot,
      sessions: new SessionStoreManager({ logger: silentLogger }),
      goalState: new GoalStateManager(workspaceRoot, silentLogger),
    } as HitlServiceOptions;

    expect(() => new HitlService(incomplete)).toThrow("project");
  });

  test("does not expose a no-op flush compatibility method", async () => {
    const { service } = await createService();
    expect("flush" in service).toBe(false);
  });

  test("shutdown does not cancel durable pending HITL", async () => {
    const { service, sessions, workspaceRoot } = await createService();
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspaceRoot, { agentName: "engineer" });
    await waitForSession(workspaceRoot, sessionId);
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: sessionId };
    const created = await service.create(input(owner, "shutdown-block"));

    service.shutdown();

    const reloaded = await createService(workspaceRoot, sessions);
    const lookup = await reloaded.service.lookup(identity(created));
    expect(lookup).toMatchObject({ status: "found", record: { hitlId: created.hitlId, status: "pending" } });
  });

  test("cancelOwner marks active owner records cancelled with owner_deleted", async () => {
    const { service, sessions, workspaceRoot } = await createService();
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspaceRoot, { agentName: "engineer" });
    await waitForSession(workspaceRoot, sessionId);
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: sessionId };
    const created = await service.create(input(owner, "owner-delete-block"));

    expect((await service.list()).map((projection) => projection.hitlId)).toContain(created.hitlId);

    const cancelled = await service.cancelOwner(owner, "owner_deleted");

    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ hitlId: created.hitlId, status: "cancelled", response: { type: "cancel", reason: "owner_deleted" } });
    expect((await service.list()).map((projection) => projection.hitlId)).not.toContain(created.hitlId);
    expect(await service.list({ scope: "project", status: "all" })).toContainEqual(expect.objectContaining({
      hitlId: created.hitlId,
      status: "cancelled",
    }));
    expect(await service.lookup(identity(created))).toMatchObject({
      status: "found",
      record: { status: "cancelled", response: { type: "cancel", reason: "owner_deleted" } },
    });
  });

  test("publishes projection-safe realtime request and status updates only after explicit publish", async () => {
    const events: GlobalSSEHitlRealtimeEvent[] = [];
    const { service, sessions, workspaceRoot } = await createService();
    const unsubscribe = service.subscribeRealtimeEvents((event) => events.push(event));
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspaceRoot, { agentName: "engineer" });
    await waitForSession(workspaceRoot, sessionId);
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: sessionId };

    const record = await service.create(input(owner, "realtime-block"));
    expect(events).toHaveLength(0);

    await service.publishRequest(record);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "hitl.event",
      projectSlug: "archcode",
      hitlId: record.hitlId,
      payload: { type: "hitl.request" },
      projection: {
        hitlId: record.hitlId,
        project: { slug: "archcode", name: "ArchCode" },
        owner,
        status: "pending",
        allowedActions: ["answer", "cancel"],
        ancestry: { rootSessionId: sessionId },
      },
    });

    const claimed = await service.claim(identity(record), { type: "question_answer", answers: ["yes"] }, claimMetadata("realtime"));
    expect(claimed?.status).toBe("answered");
    expect(events.at(-1)).toMatchObject({
      payload: { type: "hitl.updated" },
      projection: { status: "answered", allowedActions: [] },
    });

    await service.finishResume(identity(record), "resolved", { type: "question_answer", answers: ["yes"] });
    expect(events.at(-1)).toMatchObject({
      payload: { type: "hitl.resolved" },
      projection: { status: "resolved", allowedActions: [] },
    });
    unsubscribe();
  });

  test("realtime publisher and listener failures never change durable mutation results", async () => {
    const publisher = mock(async () => { throw new Error("publisher unavailable"); });
    const failingListener = mock(async () => { throw new Error("listener unavailable"); });
    const healthyEvents: GlobalSSEHitlRealtimeEvent[] = [];
    const warn = mock((_event: string) => undefined);
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn,
      error: () => undefined,
      child: () => logger,
    };
    const { service, sessions, workspaceRoot } = await createService(undefined, undefined, {
      realtimePublisher: publisher,
      logger,
    });
    service.subscribeRealtimeEvents(failingListener);
    service.subscribeRealtimeEvents((event) => healthyEvents.push(event));
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspaceRoot, { agentName: "engineer" });
    await waitForSession(workspaceRoot, sessionId);
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: sessionId };

    const record = await service.create(input(owner, "realtime-failure-block"));
    await expect(service.publishRequest(record)).resolves.toBeUndefined();
    const claimed = await service.claim(identity(record), { type: "question_answer", answers: ["yes"] }, claimMetadata("failure"));
    expect(claimed?.status).toBe("answered");
    const resolved = await service.finishResume(identity(record), "resolved", { type: "question_answer", answers: ["yes"] });
    expect(resolved?.status).toBe("resolved");

    const second = await service.create(input(owner, "realtime-failure-cancel"));
    const cancelled = await service.cancelOwner(owner, "owner_deleted");
    expect(cancelled).toContainEqual(expect.objectContaining({ hitlId: second.hitlId, status: "cancelled" }));
    expect(await service.lookup(identity(record))).toMatchObject({ status: "found", record: { status: "resolved" } });
    expect(await service.lookup(identity(second))).toMatchObject({ status: "found", record: { status: "cancelled" } });
    expect(publisher).toHaveBeenCalledTimes(4);
    expect(failingListener).toHaveBeenCalledTimes(4);
    expect(healthyEvents).toHaveLength(4);
    await Promise.resolve();
    expect(warn.mock.calls.some(([event]) => event === "hitl.realtime.publisher_failed")).toBe(true);
    expect(warn.mock.calls.some(([event]) => event === "hitl.realtime.listener_failed")).toBe(true);
  });
});

async function createService(
  workspaceRoot?: string,
  sessions?: SessionStoreManager,
  options: Pick<HitlServiceOptions, "realtimePublisher" | "logger"> = {},
) {
  workspaceRoot ??= await mkdtemp(join(TMP_ROOT, "workspace-"));
  sessions ??= new SessionStoreManager({ logger: silentLogger });
  const goalState = new GoalStateManager(workspaceRoot, silentLogger);
  const service = new HitlService({
    workspaceRoot,
    project: { slug: "archcode", name: "ArchCode" },
    sessions,
    goalState,
    ...options,
  });
  return { service, workspaceRoot, sessions, goalState };
}

function input(owner: HitlOwnerKey, blockingKey: string) {
  return {
    owner,
    ...(owner.ownerType === "session" ? { sessionRootId: owner.ownerId } : {}),
    blockingKey,
    source: owner.ownerType === "session"
      ? { type: "ask_user" as const, sessionId: owner.ownerId }
      : { type: "goal_approval" as const, goalId: owner.ownerId, approvalPoint: "after_plan" as const },
    displayPayload: { title: "Needs input", redacted: true as const },
  };
}

function claimMetadata(claimId: string): HitlDeliveryMetadata {
  return {
    claimId,
    claimedAt: new Date().toISOString(),
    intent: "respond",
    attempt: 1,
  };
}

function identity(record: { readonly owner: HitlOwnerKey; readonly hitlId: string }): HitlIdentity {
  return { owner: record.owner, hitlId: record.hitlId };
}

async function waitForSession(workspaceRoot: string, sessionId: string): Promise<void> {
  const path = join(workspaceRoot, ".archcode", "sessions", sessionId, "session.json");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`session was not persisted: ${sessionId}`);
}
