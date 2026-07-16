import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { AutomationDispatcher, type SessionDispatchGateway } from "./dispatcher";
import { AutomationStateManager } from "./state-manager";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "dispatcher", crypto.randomUUID());
const NOW = Date.parse("2026-07-13T00:00:00.000Z");

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("AutomationDispatcher", () => {
  test("dispatches through the ordinary Session gateway with the Invocation id as clientRequestId", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "/skill use reviewer", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    const calls: unknown[] = [];
    const gateway: SessionDispatchGateway = {
      dispatch: async (input) => { calls.push(input); },
    };

    const result = await new AutomationDispatcher({ stateManager: manager, gateway }).dispatchInvocation(invocation.id);
    expect(result.status).toBe("dispatched");
    expect(calls).toEqual([{
      kind: "start_session",
      workspaceRoot: TMP_ROOT,
      projectSlug: "project-a",
      sessionId: invocation.sessionId,
      clientRequestId: invocation.id,
      message: "/skill use reviewer",
      location: "project",
    }]);
  });

  test("leaves an accepted message recoverable under the same idempotency key when the dispatched checkpoint fails", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Continue", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    const clientRequestIds: string[] = [];
    const gateway: SessionDispatchGateway = {
      dispatch: async (input) => { clientRequestIds.push(input.clientRequestId); },
    };
    const update = spyOn(manager, "updateInvocation").mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(new AutomationDispatcher({ stateManager: manager, gateway }).dispatchInvocation(invocation.id)).rejects.toThrow("disk unavailable");
    update.mockRestore();
    expect((await manager.readInvocation(invocation.id)).status).toBe("pending");
    expect((await new AutomationDispatcher({ stateManager: manager, gateway }).dispatchInvocation(invocation.id)).status).toBe("dispatched");
    expect(clientRequestIds).toEqual([invocation.id, invocation.id]);
  });

  test("serializes concurrent dispatch attempts for the same Invocation", async () => {
    const manager = new AutomationStateManager(TMP_ROOT, { now: () => NOW });
    const automation = await manager.createAutomation({
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Continue", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    let dispatches = 0;
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const gateway: SessionDispatchGateway = {
      dispatch: async () => {
        dispatches += 1;
        await dispatchGate;
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
      projectSlug: "project-a",
      createdFromSessionId: crypto.randomUUID(),
      name: "run",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Continue", location: "project" },
    });
    const invocation = await manager.enqueueInvocation(automation.id, new Date(NOW).toISOString());
    const changes: unknown[] = [];
    const gateway: SessionDispatchGateway = {
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
    }]);
  });
});
