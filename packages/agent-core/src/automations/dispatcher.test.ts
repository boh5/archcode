import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { AutomationDispatcher, type SessionDispatchGateway } from "./dispatcher";
import { AutomationStateManager } from "./state-manager";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "dispatcher");
const NOW = Date.parse("2026-07-13T00:00:00.000Z");

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("AutomationDispatcher", () => {
  test("dispatches through the ordinary Session gateway with preallocated ids", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectId: "project-a",
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "/skill use reviewer", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    const calls: unknown[] = [];
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "missing",
      dispatch: async (input) => { calls.push(input); return { accepted: true }; },
    };

    const result = await new AutomationDispatcher({ stateManager: manager, gateway }).dispatchInvocation(invocation.id);
    expect(result.status).toBe("dispatched");
    expect(calls).toEqual([{
      kind: "start_session",
      workspaceRoot: TMP_ROOT,
      projectId: "project-a",
      sessionId: invocation.sessionId,
      executionId: invocation.executionId,
      message: "/skill use reviewer",
      location: "project",
    }]);
  });

  test("recovers an accepted dispatch without sending it twice", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectId: "project-a",
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "send_message", sessionId: crypto.randomUUID(), message: "Continue" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    let dispatches = 0;
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "accepted",
      dispatch: async () => { dispatches += 1; return { accepted: true }; },
    };

    const result = await new AutomationDispatcher({ stateManager: manager, gateway }).dispatchInvocation(invocation.id);
    expect(result.status).toBe("dispatched");
    expect(dispatches).toBe(0);
  });

  test("leaves an accepted execution recoverable when the dispatched checkpoint fails", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectId: "project-a",
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Continue", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "missing",
      dispatch: async () => ({ accepted: true }),
    };
    const update = spyOn(manager, "updateInvocation").mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(new AutomationDispatcher({ stateManager: manager, gateway }).dispatchInvocation(invocation.id)).rejects.toThrow("disk unavailable");
    update.mockRestore();
    expect((await manager.readInvocation(invocation.id)).status).toBe("pending");
  });

  test("keeps one coalesced pending invocation while the previous execution is active", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectId: "project-a",
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Continue", location: "project" },
    });
    const active = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    await manager.updateInvocation(active.id, { status: "dispatched", dispatchedAt: new Date(NOW).toISOString() });
    const pending = await manager.enqueueInvocation(automation.id, "2026-07-13T00:00:30.000Z");
    const gateway: SessionDispatchGateway = {
      inspectExecution: async (input) => input.executionId === active.executionId ? "active" : "missing",
      dispatch: async () => { throw new Error("must not dispatch"); },
    };

    const result = await new AutomationDispatcher({ stateManager: manager, gateway }).dispatchInvocation(pending.id);
    expect(result.status).toBe("pending");
  });

  test("serializes concurrent dispatch attempts for the same Invocation", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectId: "project-a",
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Continue", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    let dispatches = 0;
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "missing",
      dispatch: async () => {
        dispatches += 1;
        await dispatchGate;
        return { accepted: true };
      },
    };
    const dispatcher = new AutomationDispatcher({ stateManager: manager, gateway });

    const first = dispatcher.dispatchInvocation(invocation.id);
    const second = dispatcher.dispatchInvocation(invocation.id);
    await Bun.sleep(0);
    releaseDispatch();

    const results = await Promise.all([first, second]);
    expect(dispatches).toBe(1);
    expect(results.map((result) => result.status)).toEqual(["dispatched", "dispatched"]);
  });

  test("notifies after a failed Invocation is durably recorded", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectId: "project-a",
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Continue", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    const changes: unknown[] = [];
    const gateway: SessionDispatchGateway = {
      inspectExecution: async () => "missing",
      dispatch: async () => { throw new Error("Session unavailable"); },
    };

    const result = await new AutomationDispatcher({
      stateManager: manager,
      gateway,
      onChange: (change) => { changes.push(change); },
    }).dispatchInvocation(invocation.id);

    expect(result.status).toBe("failed");
    expect(changes).toEqual([{
      automationId: automation.id,
      reason: "invocation_changed",
    }]);
  });
});
