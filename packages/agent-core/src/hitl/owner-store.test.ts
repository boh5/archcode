import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HitlOwnerKey, HitlRecord, HitlDeliveryMetadata } from "@archcode/protocol";

import {
  HitlOwnerMismatchError,
  HitlOwnerStore,
  HitlRecordStateError,
  migrateHitlOwnerFileProjectSlug,
} from "./owner-store";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "owner-store");

describe("HitlOwnerStore", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("creates one owner-local hitl.json and reuses active blocking keys", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const filePath = join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json");
    const store = new HitlOwnerStore(filePath, owner);

    const first = await store.create(record(owner, "hitl-1", "same-block"));
    const second = await store.create(record(owner, "hitl-2", "same-block"));

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, reason: "active_blocking_key_exists", record: first.record });
    expect(await Bun.file(filePath).exists()).toBe(true);
    expect(await Bun.file(join(workspace, ".archcode", "hitl-queue.json")).exists()).toBe(false);
  });

  test("keeps the first accepted answer immutable while rotating retry delivery metadata", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const store = new HitlOwnerStore(join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json"), owner);
    const created = await store.create(record(owner, "immutable-answer", "immutable-answer"));
    const firstResponse = { type: "question_answer" as const, answers: ["first"] };

    await store.claim(created.record.hitlId, firstResponse, claimMetadata("first-claim"));
    await expect(store.claim(
      created.record.hitlId,
      { type: "question_answer", answers: ["replacement"] },
      claimMetadata("conflicting-claim"),
    )).rejects.toBeInstanceOf(HitlRecordStateError);

    expect(await store.lookup(created.record.hitlId)).toMatchObject({
      status: "found",
      record: { response: firstResponse, delivery: { claimId: "first-claim" } },
    });

    const retried = await store.claim(created.record.hitlId, firstResponse, claimMetadata("retry-claim"));
    expect(retried).toMatchObject({
      response: firstResponse,
      delivery: { claimId: "retry-claim" },
    });

    const [cancelled] = await store.cancelActive("session_family_stopped");
    expect(cancelled).toMatchObject({ status: "cancelled", response: firstResponse });
  });

  test("caps recentTerminal at newest 20 without evicting active records", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "goal", ownerId: crypto.randomUUID() };
    const store = new HitlOwnerStore(join(workspace, ".archcode", "goals", owner.ownerId, "hitl.json"), owner);

    await store.create(record(owner, "active-pending", "active-pending"));
    const claimed = await store.create(record(owner, "active-claimed", "active-claimed"));
    await store.claim(claimed.record.hitlId, { type: "approval_decision", decision: "approved" }, claimMetadata("active-claimed"));
    const failed = await store.create(record(owner, "active-failed", "active-failed"));
    await store.claim(failed.record.hitlId, { type: "approval_decision", decision: "approved" }, claimMetadata("active-failed"));
    await store.markDeliveryFailed(failed.record.hitlId, "adapter failed", new Date(Date.now() + 1_000).toISOString());

    for (let index = 0; index < 25; index += 1) {
      const created = await store.create(record(owner, `terminal-${index}`, `terminal-${index}`));
      await store.complete(created.record.hitlId, "resolved", { type: "approval_decision", decision: "approved" });
    }

    const file = await store.read();
    expect(file.pending.map((entry) => entry.hitlId).sort()).toEqual(["active-claimed", "active-failed", "active-pending"]);
    expect(file.recentTerminal).toHaveLength(20);
    expect(file.recentTerminal[0]?.hitlId).toBe("terminal-5");
    expect(file.recentTerminal.at(-1)?.hitlId).toBe("terminal-24");
  });

  test("migrates one workspace-local owner file to a new project slug without changing history identities", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const oldOwner: HitlOwnerKey = { projectSlug: "old-project", ownerType: "session", ownerId: crypto.randomUUID() };
    const nextOwner: HitlOwnerKey = { ...oldOwner, projectSlug: "new-project" };
    const filePath = join(workspace, ".archcode", "sessions", oldOwner.ownerId, "hitl.json");
    const oldStore = new HitlOwnerStore(filePath, oldOwner);
    await oldStore.create(record(oldOwner, "pending-id", "pending-key"));
    const terminal = await oldStore.create(record(oldOwner, "terminal-id", "terminal-key"));
    await oldStore.complete(terminal.record.hitlId, "cancelled", { type: "cancel", reason: "kept" });

    await expect(migrateHitlOwnerFileProjectSlug(filePath, nextOwner)).resolves.toBe(true);

    const migrated = await new HitlOwnerStore(filePath, nextOwner).read();
    expect(migrated.owner).toEqual(nextOwner);
    expect(migrated.pending).toEqual([
      expect.objectContaining({ hitlId: "pending-id", blockingKey: "pending-key", status: "pending", owner: nextOwner }),
    ]);
    expect(migrated.recentTerminal).toEqual([
      expect.objectContaining({ hitlId: "terminal-id", blockingKey: "terminal-key", status: "cancelled", owner: nextOwner }),
    ]);
    await expect(oldStore.read()).rejects.toBeInstanceOf(HitlOwnerMismatchError);
    await expect(migrateHitlOwnerFileProjectSlug(filePath, nextOwner)).resolves.toBe(false);
  });

  test("rejects unknown raw response fields when reading owner-local files", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const filePath = join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json");
    const store = new HitlOwnerStore(filePath, owner);
    const unsafeRecord = {
      ...record(owner, "unsafe", "unsafe"),
      status: "resolved",
      response: { type: "approval_decision", decision: "approved", rawToolInput: { secret: "value" } },
      resolvedAt: new Date().toISOString(),
    };

    await Bun.write(filePath, `${JSON.stringify({
      version: 1,
      owner,
      pending: [],
      recentTerminal: [unsafeRecord],
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    await expectRejects(store.read(), Error);
  });

  test("rejects unversioned owner files and the removed resume attempts field", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const filePath = join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json");
    const store = new HitlOwnerStore(filePath, owner);
    const updatedAt = new Date().toISOString();
    const claimed = {
      ...record(owner, "legacy-attempts", "legacy-attempts"),
      status: "answered",
      response: { type: "question_answer", answers: ["continue"] },
      delivery: { claimId: "legacy-claim", attempts: 2 },
    };

    await Bun.write(filePath, `${JSON.stringify({
      owner,
      pending: [],
      recentTerminal: [],
      updatedAt,
    }, null, 2)}\n`);
    await expectRejects(store.read(), Error);

    await Bun.write(filePath, `${JSON.stringify({
      version: 1,
      owner,
      pending: [claimed],
      recentTerminal: [],
      updatedAt,
    }, null, 2)}\n`);
    await expectRejects(store.read(), Error);
  });

  test("rejects claimed records without a complete resume identity", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const store = new HitlOwnerStore(join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json"), owner);
    const created = await store.create(record(owner, "incomplete-claim", "incomplete-claim"));

    await expectRejects(store.claim(
      created.record.hitlId,
      { type: "question_answer", answers: ["continue"] },
      {} as HitlDeliveryMetadata,
    ), Error);

    const lookup = await store.lookup(created.record.hitlId);
    expect(lookup).toMatchObject({ status: "found", record: { status: "pending" } });
    if (lookup.status !== "found") throw new Error("Expected the original pending HITL record");
    expect(lookup.record).not.toHaveProperty("response");
    expect(lookup.record).not.toHaveProperty("resume");
  });

  test("rejects owner files whose records are stored in the wrong status bucket", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "goal", ownerId: crypto.randomUUID() };
    const filePath = join(workspace, ".archcode", "goals", owner.ownerId, "hitl.json");
    const store = new HitlOwnerStore(filePath, owner);
    const now = new Date().toISOString();
    const active = record(owner, "active-in-terminal", "active-in-terminal");
    const terminal = {
      ...record(owner, "terminal-in-pending", "terminal-in-pending"),
      status: "resolved",
      response: { type: "approval_decision", decision: "approved" },
      resolvedAt: now,
    };

    await Bun.write(filePath, `${JSON.stringify({
      version: 1,
      owner,
      pending: [terminal],
      recentTerminal: [],
      updatedAt: now,
    }, null, 2)}\n`);
    await expectRejects(store.read(), HitlRecordStateError);

    await Bun.write(filePath, `${JSON.stringify({
      version: 1,
      owner,
      pending: [],
      recentTerminal: [active],
      updatedAt: now,
    }, null, 2)}\n`);
    await expectRejects(store.read(), HitlRecordStateError);
  });

  test("rejects same-owner duplicate hitlIds for different active blocking keys", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const store = new HitlOwnerStore(join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json"), owner);

    await store.create(record(owner, "duplicated-hitl", "first-block"));

    await expectRejects(store.create(record(owner, "duplicated-hitl", "second-block")), HitlRecordStateError);
    expect((await store.list()).map((entry) => entry.blockingKey)).toEqual(["first-block"]);
  });

  test("rejects active creation that reuses a terminal hitlId", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "goal", ownerId: crypto.randomUUID() };
    const store = new HitlOwnerStore(join(workspace, ".archcode", "goals", owner.ownerId, "hitl.json"), owner);

    const terminal = await store.create(record(owner, "terminal-hitl", "terminal-block"));
    await store.complete(terminal.record.hitlId, "resolved", { type: "approval_decision", decision: "approved" });

    await expectRejects(store.create(record(owner, "terminal-hitl", "new-block")), HitlRecordStateError);
    expect((await store.list()).map((entry) => entry.hitlId)).toEqual(["terminal-hitl"]);
  });

  test("rejects writes with duplicate hitlIds in one owner-local file", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const store = new HitlOwnerStore(join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json"), owner);
    const pending = record(owner, "duplicated-file-hitl", "pending-block");
    const terminal = {
      ...record(owner, "duplicated-file-hitl", "terminal-block"),
      status: "cancelled" as const,
      response: { type: "cancel" as const, reason: "test" },
      resolvedAt: new Date().toISOString(),
    };

    await expectRejects(store.write({
      version: 1,
      owner,
      pending: [pending],
      recentTerminal: [terminal],
      updatedAt: new Date().toISOString(),
    }), HitlRecordStateError);
  });

  test("rejects records whose owner differs from the owner-local file", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const foreignOwner: HitlOwnerKey = { ...owner, ownerId: crypto.randomUUID() };
    const filePath = join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json");
    const store = new HitlOwnerStore(filePath, owner);
    const foreignRecord = record(foreignOwner, "foreign-owner", "foreign-owner");
    const file = {
      version: 1 as const,
      owner,
      pending: [foreignRecord],
      recentTerminal: [],
      updatedAt: new Date().toISOString(),
    };

    await expectRejects(store.write(file), HitlOwnerMismatchError);
    await Bun.write(filePath, `${JSON.stringify(file, null, 2)}\n`);
    await expectRejects(store.read(), HitlOwnerMismatchError);
  });

  test("rejects records whose source type or id differs from their owner", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const filePath = join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json");
    const store = new HitlOwnerStore(filePath, owner);
    const wrongSourceId = {
      ...record(owner, "wrong-source-id", "wrong-source-id"),
      source: { type: "ask_user" as const, sessionId: crypto.randomUUID() },
    };
    const wrongSourceType = {
      ...record(owner, "wrong-source-type", "wrong-source-type"),
      source: { type: "goal_review" as const, goalId: owner.ownerId },
    };

    await expectRejects(store.create(wrongSourceId), HitlRecordStateError);
    await expectRejects(store.write({
      version: 1,
      owner,
      pending: [wrongSourceType],
      recentTerminal: [],
      updatedAt: new Date().toISOString(),
    }), HitlRecordStateError);

    await Bun.write(filePath, `${JSON.stringify({
      version: 1,
      owner,
      pending: [wrongSourceId],
      recentTerminal: [],
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await expectRejects(store.read(), HitlRecordStateError);
  });

  test("rejects reads from an owner-local file that already contains duplicate hitlIds", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const filePath = join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json");
    const store = new HitlOwnerStore(filePath, owner);
    const pending = record(owner, "duplicated-file-hitl", "pending-block");
    const terminal = {
      ...record(owner, "duplicated-file-hitl", "terminal-block"),
      status: "cancelled" as const,
      response: { type: "cancel" as const, reason: "test" },
      resolvedAt: new Date().toISOString(),
    };

    await Bun.write(filePath, `${JSON.stringify({
      version: 1,
      owner,
      pending: [pending],
      recentTerminal: [terminal],
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    await expectRejects(store.lookup("duplicated-file-hitl"), HitlRecordStateError);
  });

  test("serializes reads with concurrent owner-file mutations", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const filePath = join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json");
    const store = new HitlOwnerStore(filePath, owner);
    for (let index = 0; index < 24; index += 1) {
      await store.create(record(owner, `concurrent-read-${index}`, `concurrent-block-${index}`));
    }

    await Promise.all([
      ...Array.from({ length: 12 }, (_, index) => (
        new HitlOwnerStore(filePath, owner).complete(
          `concurrent-read-${index}`,
          "resolved",
          { type: "question_answer", answers: ["done"] },
        )
      )),
      ...Array.from({ length: 48 }, () => new HitlOwnerStore(filePath, owner).read()),
    ]);

    const file = await store.read();
    expect(file.pending).toHaveLength(12);
    expect(file.recentTerminal).toHaveLength(12);
  });

  test("serializes create claim and complete across store instances sharing one owner file", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: crypto.randomUUID() };
    const filePath = join(workspace, ".archcode", "sessions", owner.ownerId, "hitl.json");
    const first = new HitlOwnerStore(filePath, owner);
    const second = new HitlOwnerStore(filePath, owner);
    const third = new HitlOwnerStore(filePath, owner);

    await Promise.all([
      first.create(record(owner, "hitl-create-a", "block-create-a")),
      second.create(record(owner, "hitl-create-b", "block-create-b")),
      third.create(record(owner, "hitl-create-c", "block-create-c")),
    ]);

    await Promise.all([
      new HitlOwnerStore(filePath, owner).create(record(owner, "hitl-created-concurrently", "block-created-concurrently")),
      new HitlOwnerStore(filePath, owner).claim(
        "hitl-create-a",
        { type: "question_answer", answers: ["approved"] },
        claimMetadata("hitl-create-a"),
      ),
      new HitlOwnerStore(filePath, owner).complete("hitl-create-b", "resolved", { type: "question_answer", answers: ["done"] }),
    ]);

    const file = await new HitlOwnerStore(filePath, owner).read();
    expect(file.pending.map((entry) => [entry.hitlId, entry.status]).sort()).toEqual([
      ["hitl-create-a", "answered"],
      ["hitl-create-c", "pending"],
      ["hitl-created-concurrently", "pending"],
    ]);
    expect(file.recentTerminal.map((entry) => [entry.hitlId, entry.status])).toEqual([
      ["hitl-create-b", "resolved"],
    ]);
  });
});

async function expectRejects(promise: Promise<unknown>, expectedError?: new (...args: never[]) => Error): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (expectedError !== undefined) expect(error).toBeInstanceOf(expectedError);
    return;
  }
  throw new Error("Expected promise to reject");
}

function record(owner: HitlOwnerKey, hitlId: string, blockingKey: string): HitlRecord {
  const now = new Date().toISOString();
  return {
    hitlId,
    owner,
    ...(owner.ownerType === "session" ? { sessionRootId: owner.ownerId } : {}),
    blockingKey,
    source: owner.ownerType === "session"
      ? { type: "ask_user", sessionId: owner.ownerId }
      : { type: "goal_budget", goalId: owner.ownerId, approvalPoint: "approval_budget_1" },
    status: "pending",
    displayPayload: { title: "Needs input", redacted: true },
    createdAt: now,
    updatedAt: now,
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
