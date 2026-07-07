import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HitlOwnerKey } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { silentLogger } from "../logger";
import { LoopStateManager } from "../loops/state";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionHitlPath } from "../store/sessions-dir";
import { HitlService } from "./service";
import type { HitlEvent } from "./types";

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

  test("legacy request reuses an existing active blocking key without emitting a phantom hitlId", async () => {
    const events: Array<{ sessionId: string; event: HitlEvent }> = [];
    const { service, sessions, workspaceRoot } = await createLoadedService(undefined, undefined, events);
    const sessionId = crypto.randomUUID();
    sessions.create(sessionId, workspaceRoot);
    await waitForSession(workspaceRoot, sessionId);
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: sessionId };
    const existing = await service.create({
      ...input(owner, `session:${sessionId}:ask:tool-call`),
      hitlId: "existing-hitl",
      source: { type: "ask_user", sessionId, toolCallId: "tool-call" },
    });

    const pending = service.request(
      sessionId,
      "question",
      { title: "Need input", message: "Answer", details: {} },
      { projectSlug: "archcode", source: "tool-call" },
    );
    await waitFor(() => events.some((entry) => entry.event.type === "hitl.request"));

    const requestEvent = events.find((entry) => entry.event.type === "hitl.request")?.event;
    expect(requestEvent).toMatchObject({ type: "hitl.request", hitlId: existing.hitlId });
    expect(service.listPending("archcode").map((request) => request.hitlId)).toEqual([existing.hitlId]);

    expect(service.respond(existing.hitlId, { answers: ["yes"] }, "archcode")).toBe(true);
    expect(await pending).toMatchObject({ hitlId: existing.hitlId, status: "resolved" });
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
});

async function createLoadedService(
  workspaceRoot?: string,
  sessions = new SessionStoreManager({ logger: silentLogger }),
  events?: Array<{ sessionId: string; event: HitlEvent }>,
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
    events: events === undefined ? undefined : { submitHitlEvent: (sessionId, event) => events.push({ sessionId, event }) },
  });
  await service.load(workspaceRoot);
  return { service, workspaceRoot, sessions, goalState, loopState };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
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
