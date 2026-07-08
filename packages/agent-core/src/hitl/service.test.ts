import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GlobalSSEHitlRealtimeEvent, HitlOwnerKey } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { silentLogger } from "../logger";
import { LoopStateManager } from "../loops/state";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionHitlPath } from "../store/sessions-dir";
import { HitlService } from "./service";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "service");

describe("HitlService owner-local storage", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("creates Session, Goal, and Loop HITL records beside their owners", async () => {
    const { service, workspaceRoot, goalState, loopState } = await createLoadedService();
    const sessionOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const goalOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "goal", ownerId: crypto.randomUUID() };
    const loopOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "loop", ownerId: crypto.randomUUID() };

    await service.create(input(sessionOwner, "session-block"));
    await service.create(input(goalOwner, "goal-block"));
    await service.create(input(loopOwner, "loop-block"));

    expect(await Bun.file(getSessionHitlPath(workspaceRoot, sessionOwner.ownerId)).exists()).toBe(true);
    expect(await Bun.file(await goalState.goalHitlPath(goalOwner.ownerId)).exists()).toBe(true);
    expect(await Bun.file(await loopState.loopHitlPath(loopOwner.ownerId)).exists()).toBe(true);
    expect(await Bun.file(join(workspaceRoot, ".archcode", "hitl-queue.json")).exists()).toBe(false);
  });

  test("lookup scans known owners and reports missing or ambiguous ids", async () => {
    const { service, sessions, workspaceRoot } = await createLoadedService();
    const firstSession = crypto.randomUUID();
    const secondSession = crypto.randomUUID();
    sessions.create(firstSession, workspaceRoot);
    sessions.create(secondSession, workspaceRoot);
    await waitForSession(workspaceRoot, firstSession);
    await waitForSession(workspaceRoot, secondSession);

    const firstOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: firstSession };
    const secondOwner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: secondSession };
    await service.create({ ...input(firstOwner, "first"), hitlId: "duplicated-hitl" });
    await service.create({ ...input(secondOwner, "second"), hitlId: "duplicated-hitl" });

    expect(await service.lookup("missing-hitl")).toEqual({ status: "missing" });
    expect(await service.lookup("duplicated-hitl")).toMatchObject({ status: "ambiguous", hitlId: "duplicated-hitl" });
  });

  test("shutdown does not cancel durable pending HITL", async () => {
    const { service, sessions, workspaceRoot } = await createLoadedService();
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspaceRoot);
    await waitForSession(workspaceRoot, sessionId);
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: sessionId };
    const created = await service.create(input(owner, "shutdown-block"));

    service.shutdown();

    const reloaded = await createLoadedService(workspaceRoot, sessions);
    const lookup = await reloaded.service.lookup(created.hitlId);
    expect(lookup).toMatchObject({ status: "found", record: { hitlId: created.hitlId, status: "pending" } });
  });

  test("cancelOwner marks active owner records cancelled with owner_deleted", async () => {
    const { service, sessions, workspaceRoot } = await createLoadedService();
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspaceRoot);
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
    expect(await service.lookup(created.hitlId)).toMatchObject({
      status: "found",
      record: { status: "cancelled", response: { type: "cancel", reason: "owner_deleted" } },
    });
  });

  test("publishes projection-safe realtime request and status updates only after explicit publish", async () => {
    const events: GlobalSSEHitlRealtimeEvent[] = [];
    const { service, sessions, workspaceRoot } = await createLoadedService();
    const unsubscribe = service.subscribeRealtimeEvents((event) => events.push(event));
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspaceRoot);
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
      payload: { type: "hitl.request", status: "pending" },
      projection: {
        hitlId: record.hitlId,
        project: { slug: "archcode", name: "ArchCode" },
        owner,
        status: "pending",
        allowedActions: ["answer", "cancel"],
        ancestry: { rootSessionId: sessionId },
      },
    });

    const claimed = await service.claim(record.hitlId, { type: "question_answer", answers: ["yes"] });
    expect(claimed?.status).toBe("resume_claimed");
    expect(events.at(-1)).toMatchObject({
      payload: { type: "hitl.updated", status: "resume_claimed" },
      projection: { status: "resume_claimed", allowedActions: [] },
    });

    await service.finishResume(record.hitlId, "resolved", { type: "question_answer", answers: ["yes"] });
    expect(events.at(-1)).toMatchObject({
      payload: { type: "hitl.resolved", status: "resolved" },
      projection: { status: "resolved", allowedActions: [] },
    });
    unsubscribe();
  });
});

async function createLoadedService(
  workspaceRoot?: string,
  sessions = new SessionStoreManager({ logger: silentLogger }),
) {
  workspaceRoot ??= await mkdtemp(join(TMP_ROOT, "workspace-"));
  const goalState = new GoalStateManager(workspaceRoot, silentLogger);
  const loopState = new LoopStateManager(workspaceRoot, silentLogger);
  const service = new HitlService({
    workspaceRoot,
    project: { slug: "archcode", name: "ArchCode" },
    sessions,
    goalState,
    loopState,
  });
  await service.load(workspaceRoot);
  return { service, workspaceRoot, sessions, goalState, loopState };
}

function input(owner: HitlOwnerKey, blockingKey: string) {
  return {
    owner,
    blockingKey,
    source: owner.ownerType === "session"
      ? { type: "ask_user" as const, sessionId: owner.ownerId }
      : owner.ownerType === "goal"
        ? { type: "goal_approval" as const, goalId: owner.ownerId, approvalPoint: "after_plan" as const }
        : { type: "loop_approval" as const, loopId: owner.ownerId, approvalPoint: "manual" },
    displayPayload: { title: "Needs input", redacted: true as const },
  };
}

async function waitForSession(workspaceRoot: string, sessionId: string): Promise<void> {
  const path = join(workspaceRoot, ".archcode", "sessions", sessionId, "session.json");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`session was not persisted: ${sessionId}`);
}
