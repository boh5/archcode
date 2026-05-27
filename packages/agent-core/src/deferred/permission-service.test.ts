import { afterEach, describe, expect, test } from "bun:test";
import type { ToolConfirmationRequest, ToolConfirmationResult } from "../tools/types";
import { SessionStoreManager } from "../store/session-store-manager";
import { silentLogger } from "../logger";
import { DeferredPermissionService } from "./permission-service";
import type { DeferredSessionEvent } from "./types";

const manager = new SessionStoreManager({ logger: silentLogger });

const request: ToolConfirmationRequest = {
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: "rm -rf tmp" },
  description: "Run command",
};

function createService() {
  const sessionId = `session-${crypto.randomUUID()}`;
  const workspaceRoot = `/tmp/specra-deferred-permission-${crypto.randomUUID()}`;
  const store = manager.create(sessionId, workspaceRoot);
  const service = new DeferredPermissionService({
    submitDeferredEvent(root: string, id: string, event: DeferredSessionEvent) {
      manager.get(id, root)?.getState().append(event);
    },
  });

  return { service, sessionId, workspaceRoot, store };
}

function requestPermission(response?: ToolConfirmationResult) {
  const current = createService();
  const promise = current.service.request(current.sessionId, current.workspaceRoot, request);
  const event = current.store.getState().events.find((entry) => entry.kind === "permission.request");
  if (event?.payload.type !== "permission.request") throw new Error("permission request event missing");

  if (response) current.service.respond(event.payload.permissionId, response);
  return { ...current, promise, permissionId: event.payload.permissionId, payload: event.payload };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("DeferredPermissionService", () => {
  afterEach(() => manager.clearAll());

  test("approve response resolves and appends terminal event", async () => {
    const { service, promise, permissionId, payload, store } = requestPermission();

    expect(service.has(permissionId)).toBe(true);
    expect(payload).toMatchObject({
      permissionId,
      toolName: request.toolName,
      args: request.input,
      description: request.description,
    });

    expect(service.respond(permissionId, "approve_once")).toBe(true);
    await expect(promise).resolves.toBe("approve_once");
    expect(service.has(permissionId)).toBe(false);
    expect(store.getState().events.map((event) => event.kind)).toEqual([
      "permission.request",
      "permission.terminal",
    ]);
    expect(store.getState().events.at(-1)?.payload).toMatchObject({
      type: "permission.terminal",
      permissionId,
      status: "resolved",
    });
  });

  test("deny response resolves and appends denied terminal event", async () => {
    const { promise, store, permissionId } = requestPermission("deny");

    await expect(promise).resolves.toBe("deny");
    expect(store.getState().events.at(-1)?.payload).toMatchObject({ permissionId, status: "denied" });
  });

  test("pre-aborted request appends timeout terminal event", async () => {
    const { service, sessionId, workspaceRoot, store } = createService();
    const abortController = new AbortController();
    abortController.abort();

    const promise = service.request(sessionId, workspaceRoot, request, abortController.signal);

    await expect(promise).resolves.toBe("timeout");
    expect(store.getState().events.map((event) => event.kind)).toEqual([
      "permission.request",
      "permission.terminal",
    ]);
    expect(store.getState().events.at(-1)?.payload).toMatchObject({ status: "timeout" });
  });

  test("abort signal resolves timeout and appends timeout terminal event", async () => {
    const { service, sessionId, workspaceRoot, store } = createService();
    const abortController = new AbortController();
    const promise = service.request(sessionId, workspaceRoot, request, abortController.signal);
    const event = store.getState().events.find((entry) => entry.kind === "permission.request");
    if (event?.payload.type !== "permission.request") throw new Error("permission request event missing");

    abortController.abort();
    await flushMicrotasks();

    await expect(promise).resolves.toBe("timeout");
    expect(service.has(event.payload.permissionId)).toBe(false);
    expect(service.respond(event.payload.permissionId, "approve_once")).toBe(false);
    expect(store.getState().events.at(-1)?.payload).toMatchObject({
      permissionId: event.payload.permissionId,
      status: "timeout",
    });
  });

  test("cleanup resolves timeout and appends cancelled terminal event", async () => {
    const { service, promise, permissionId, store, sessionId, workspaceRoot } = requestPermission();

    service.cleanup(sessionId, workspaceRoot);

    await expect(promise).resolves.toBe("timeout");
    expect(service.has(permissionId)).toBe(false);
    expect(store.getState().events.at(-1)?.payload).toMatchObject({
      type: "permission.terminal",
      permissionId,
      status: "cancelled",
    });
  });

  test("respond to missing permission returns false", () => {
    const { service } = createService();

    expect(service.respond("missing", "deny")).toBe(false);
  });
});
