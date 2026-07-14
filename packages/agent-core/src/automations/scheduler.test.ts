import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { AutomationCoordinator } from "./coordinator";
import { AutomationDispatcher, type SessionDispatchGateway } from "./dispatcher";
import { AutomationScheduler } from "./scheduler";
import { AutomationStateManager } from "./state-manager";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "scheduler", crypto.randomUUID());
const START = Date.parse("2026-07-13T00:00:00.000Z");

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("AutomationScheduler", () => {
  test("materializes a durable invocation before dispatch and advances recurring schedules", async () => {
    let now = START;
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => now });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "watch",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
    });
    const seenPersistedStatuses: string[] = [];
    const changes: unknown[] = [];
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "missing",
      dispatch: async () => {
        seenPersistedStatuses.push((await manager.listInvocations(automation.id))[0]?.status ?? "missing");
        return { accepted: true };
      },
    };
    const scheduler = new AutomationScheduler({
      stateManager: manager,
      dispatcher: new AutomationDispatcher({
        stateManager: manager,
        gateway,
        now: () => now,
        onChange: (change) => { changes.push(change); },
      }),
      clock: { now: () => now },
      timer: { schedule: () => ({}), cancel: () => {} },
      onChange: (change) => { changes.push(change); },
    });

    now += 30_000;
    await scheduler.tick();

    expect(seenPersistedStatuses).toEqual(["pending"]);
    expect((await manager.listInvocations(automation.id))[0]?.status).toBe("dispatched");
    expect((await manager.readAutomation(automation.id)).nextFireAt).toBe("2026-07-13T00:01:00.000Z");
    expect(changes).toEqual([
      { automationId: automation.id },
      { automationId: automation.id },
    ]);
  });

  test("notifies after CRUD and run-now persistence", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => START });
    const changes: unknown[] = [];
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "missing",
      dispatch: async () => ({ accepted: true }),
    };
    const onChange = (change: unknown): void => { changes.push(change); };
    const scheduler = new AutomationScheduler({
      stateManager: manager,
      dispatcher: new AutomationDispatcher({ stateManager: manager, gateway, onChange }),
      clock: { now: () => START },
      timer: { schedule: () => ({}), cancel: () => {} },
      onChange,
    });
    const automation = await scheduler.createAutomation({
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "watch",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
    });
    await scheduler.updateAutomation(automation.id, { name: "renamed" });
    await scheduler.runAutomationNow(automation.id);
    await scheduler.pauseAutomation(automation.id);
    await scheduler.resumeAutomation(automation.id);
    await scheduler.deleteAutomation(automation.id);

    expect(changes).toEqual([
      { automationId: automation.id },
      { automationId: automation.id },
      { automationId: automation.id },
      { automationId: automation.id },
      { automationId: automation.id },
      { automationId: automation.id },
      { automationId: automation.id },
    ]);
  });

  test("startup skips offline recurring occurrences but recovers durable pending dispatches", async () => {
    let now = START;
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => now });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "watch",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "send_message", sessionId: crypto.randomUUID(), message: "Continue" },
    });
    const pending = await manager.enqueueInvocation(automation.id, "2026-07-13T00:00:20.000Z");
    now += 10 * 60_000;
    const dispatched: string[] = [];
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "missing",
      dispatch: async (input) => { dispatched.push(input.executionId); return { accepted: true }; },
    };
    const scheduler = new AutomationScheduler({
      stateManager: manager,
      dispatcher: new AutomationDispatcher({ stateManager: manager, gateway, now: () => now }),
      clock: { now: () => now },
      timer: { schedule: () => ({}), cancel: () => {} },
    });

    await scheduler.start();

    expect(dispatched).toEqual([pending.executionId]);
    expect((await manager.readAutomation(automation.id)).nextFireAt).toBe("2026-07-13T00:10:30.000Z");
    expect(await manager.listInvocations(automation.id)).toHaveLength(1);
    scheduler.dispose();
  });

  test("run-now does not mutate the configured trigger or its next occurrence", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => START });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "watch",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
    });
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "missing",
      dispatch: async () => ({ accepted: true }),
    };
    const scheduler = new AutomationScheduler({
      stateManager: manager,
      dispatcher: new AutomationDispatcher({ stateManager: manager, gateway, now: () => START }),
      clock: { now: () => START },
      timer: { schedule: () => ({}), cancel: () => {} },
    });

    const invocation = await scheduler.runAutomationNow(automation.id);
    expect(invocation.status).toBe("dispatched");
    expect((await manager.readAutomation(automation.id)).trigger).toEqual(automation.trigger);
    expect((await manager.readAutomation(automation.id)).nextFireAt).toBe(automation.nextFireAt);
  });

  test("linearizes pause with an already claimed dispatch", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => START });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "watch",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(START).toISOString());
    const coordinator = new AutomationCoordinator();
    let enteredDispatch!: () => void;
    let releaseDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => { enteredDispatch = resolve; });
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "missing",
      dispatch: async () => {
        enteredDispatch();
        await dispatchGate;
        return { accepted: true };
      },
    };
    const dispatcher = new AutomationDispatcher({ stateManager: manager, gateway, coordinator });
    const scheduler = new AutomationScheduler({
      stateManager: manager,
      dispatcher,
      clock: { now: () => START },
      timer: { schedule: () => ({}), cancel: () => {} },
    });

    const dispatch = dispatcher.dispatchInvocation(invocation.id);
    await dispatchEntered;
    let pauseSettled = false;
    const pause = scheduler.pauseAutomation(automation.id).then((result) => {
      pauseSettled = true;
      return result;
    });
    await Bun.sleep(0);
    expect(pauseSettled).toBe(false);

    releaseDispatch();
    expect((await dispatch).status).toBe("dispatched");
    expect((await pause).status).toBe("paused");
    expect((await manager.readInvocation(invocation.id)).status).toBe("dispatched");
  });

  test("reconciles an accepted dispatch before pause cancels pending work", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => START });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "watch",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(START).toISOString());
    let accepted = false;
    let dispatches = 0;
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => accepted ? "accepted" : "missing",
      dispatch: async () => {
        dispatches += 1;
        accepted = true;
        return { accepted: true };
      },
    };
    const dispatcher = new AutomationDispatcher({ stateManager: manager, gateway });
    const scheduler = new AutomationScheduler({
      stateManager: manager,
      dispatcher,
      clock: { now: () => START },
      timer: { schedule: () => ({}), cancel: () => {} },
    });
    const update = spyOn(manager, "updateInvocation").mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(dispatcher.dispatchInvocation(invocation.id)).rejects.toThrow("disk unavailable");
    update.mockRestore();
    expect((await manager.readInvocation(invocation.id)).status).toBe("pending");

    expect((await scheduler.pauseAutomation(automation.id)).status).toBe("paused");
    expect((await manager.readInvocation(invocation.id)).status).toBe("dispatched");
    expect(dispatches).toBe(1);
  });
});
