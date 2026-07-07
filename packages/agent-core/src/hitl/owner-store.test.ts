import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HitlOwnerKey, HitlRecord } from "@archcode/protocol";

import { HitlOwnerStore, HitlRecordStateError } from "./owner-store";

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

  test("caps recentTerminal at newest 20 without evicting active records", async () => {
    const workspace = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "goal", ownerId: crypto.randomUUID() };
    const store = new HitlOwnerStore(join(workspace, ".archcode", "goals", owner.ownerId, "hitl.json"), owner);

    await store.create(record(owner, "active-pending", "active-pending"));
    const claimed = await store.create(record(owner, "active-claimed", "active-claimed"));
    await store.claim(claimed.record.hitlId, { type: "approval_decision", decision: "approved" });
    const failed = await store.create(record(owner, "active-failed", "active-failed"));
    await store.markResumeFailed(failed.record.hitlId, "adapter failed");

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
    blockingKey,
    source: owner.ownerType === "session"
      ? { type: "ask_user", sessionId: owner.ownerId }
      : owner.ownerType === "goal"
        ? { type: "goal_budget", goalId: owner.ownerId, approvalPoint: "approval_budget_1" }
        : { type: "loop_blocker", loopId: owner.ownerId, reason: "needs_user" },
    status: "pending",
    displayPayload: { title: "Needs input", redacted: true },
    createdAt: now,
    updatedAt: now,
  };
}
