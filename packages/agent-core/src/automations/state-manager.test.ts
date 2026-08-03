import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { AutomationStateManager } from "./state-manager";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "state-manager", crypto.randomUUID());
const NOW = Date.parse("2026-07-13T00:00:00.000Z");

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("AutomationStateManager", () => {
  test("persists strict state under .archcode/runtime/automations and reloads it", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      origin: {
        kind: "todo",
        sessionId: "11111111-1111-4111-8111-111111111111",
        todoId: "22222222-2222-4222-8222-222222222222",
      },
      name: "daily check",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: { kind: "start_session", message: "Review the project", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, "2026-07-13T00:01:00.000Z");

    const reloaded = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    expect((await reloaded.listAutomations()).map((item) => item.id)).toEqual([automation.id]);
    expect((await reloaded.readAutomation(automation.id)).origin).toEqual({
      kind: "todo",
      sessionId: "11111111-1111-4111-8111-111111111111",
      todoId: "22222222-2222-4222-8222-222222222222",
    });
    expect((await reloaded.listInvocations(automation.id))[0]).toEqual(invocation);
    expect(await reloaded.listInventory()).toEqual([{
      automation,
      latestInvocation: invocation,
    }]);
    expect(await Bun.file(join(TMP_ROOT, ".archcode", "runtime", "automations", "state.json")).exists()).toBe(true);

    await expect(manager.updateAutomation(automation.id, {
      origin: { kind: "direct" },
    } as never)).rejects.toThrow();
    expect((await manager.readAutomation(automation.id)).origin).toEqual(automation.origin);
  });

  test("rejects over-limit create and update inputs before persistence", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    await expect(manager.createAutomation({
      projectSlug: "project-a",
      origin: { kind: "direct" },
      name: "n".repeat(201),
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
    })).rejects.toThrow();
    expect(await manager.listAutomations()).toEqual([]);

    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      origin: { kind: "direct" },
      name: "valid",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
    });
    expect(automation.origin).toEqual({ kind: "direct" });
    await expect(manager.updateAutomation(automation.id, {
      action: { kind: "start_session", message: "x".repeat(10_001), location: "project" },
    })).rejects.toThrow();
    expect((await manager.readAutomation(automation.id)).action.message).toBe("Check");
  });

  test("preallocates a stable Session id and coalesces pending work", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      origin: { kind: "direct" },
      name: "watch",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
    });
    const first = await manager.enqueueInvocation(automation.id, "2026-07-13T00:00:30.000Z");
    const coalesced = await manager.enqueueInvocation(automation.id, "2026-07-13T00:01:00.000Z");

    expect(coalesced.id).toBe(first.id);
    expect(coalesced.sessionId).toBe(first.sessionId);
    expect(coalesced.dueAt).toBe("2026-07-13T00:01:00.000Z");
    expect((await manager.listInvocations(automation.id))).toHaveLength(1);
  });

  test("selects the latest scheduled occurrence instead of the last appended record", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      origin: { kind: "direct" },
      name: "ordered history",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
    });
    const latest = await manager.enqueueInvocation(automation.id, "2026-07-13T00:02:00.000Z");
    const statePath = join(TMP_ROOT, ".archcode", "runtime", "automations", "state.json");
    const state = await Bun.file(statePath).json() as { invocations: unknown[] };
    state.invocations.push({
      id: crypto.randomUUID(),
      automationId: automation.id,
      dueAt: "2026-07-13T00:01:00.000Z",
      status: "missed",
      createdAt: "2026-07-13T00:03:00.000Z",
    });
    await Bun.write(statePath, `${JSON.stringify(state, null, 2)}\n`);

    expect((await new AutomationStateManager(TMP_ROOT).listInventory())[0]?.latestInvocation?.id).toBe(latest.id);
  });

  test("pause cancels pending, resume skips offline occurrences, and delete is scoped", async () => {
    let now = NOW;
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => now });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      origin: { kind: "direct" },
      name: "watch",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "send_message", sessionId: crypto.randomUUID(), message: "Continue" },
    });
    await manager.enqueueInvocation(automation.id, "2026-07-13T00:00:30.000Z");
    const paused = await manager.pauseAutomation(automation.id);
    expect(paused.status).toBe("paused");
    expect((await manager.listInvocations(automation.id))[0]?.status).toBe("cancelled");

    now += 10 * 60_000;
    const resumed = await manager.resumeAutomation(automation.id);
    expect(resumed.nextFireAt).toBe("2026-07-13T00:10:30.000Z");

    await manager.deleteAutomation(automation.id);
    expect(await manager.listAutomations()).toEqual([]);
    expect(await manager.listInvocations(automation.id)).toEqual([]);
  });

  test("records an expired one-shot as missed and disables it during recovery", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      origin: { kind: "direct" },
      name: "expired",
      trigger: { kind: "once", at: "2026-07-12T23:59:00.000Z" },
      action: { kind: "start_session", message: "Too late", location: "project" },
    });
    expect(automation.status).toBe("disabled");
    expect((await manager.listInvocations(automation.id))[0]?.status).toBe("missed");

    await manager.resumeAutomation(automation.id);
    await manager.resumeAutomation(automation.id);
    expect(await manager.listInvocations(automation.id)).toHaveLength(1);
  });
});
