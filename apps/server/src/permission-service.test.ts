import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolConfirmationRequest, ToolConfirmationResult } from "@specra/agent-core";
import { createSessionStore } from "@specra/agent-core";
import { PermissionService } from "./permission-service";

const tmpRoots: string[] = [];

const request: ToolConfirmationRequest = {
  toolName: "bash",
  toolCallId: "call-1",
  input: { command: "rm -rf tmp" },
  description: "Run command",
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function createWorkspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specra-permission-service-"));
  tmpRoots.push(root);
  return root;
}

async function createPending(response?: ToolConfirmationResult) {
  const service = new PermissionService();
  const sessionId = `session-${crypto.randomUUID()}`;
  const workspaceRoot = await createWorkspaceRoot();
  const store = createSessionStore(sessionId, workspaceRoot);
  const promise = service.request(sessionId, workspaceRoot, request, store);
  const event = store.getState().events.find((entry) => entry.kind === "permission.request");
  if (!event) {
    throw new Error("permission request event missing");
  }

  const payload = event.payload as {
    permissionId: string;
    toolName: string;
    args: unknown;
    description?: string;
  };

  if (response) {
    service.respond(payload.permissionId, response);
  }

  return { service, store, workspaceRoot, promise, id: payload.permissionId, payload };
}

describe("PermissionService", () => {
  test("request creates Deferred, respond resolves it", async () => {
    const { service, promise, id, payload, store } = await createPending();

    expect(service.has(id)).toBe(true);
    expect(payload).toMatchObject({
      permissionId: id,
      toolName: request.toolName,
      args: request.input,
      description: request.description,
    });

    expect(service.respond(id, "approve_once")).toBe(true);
    await expect(promise).resolves.toBe("approve_once");
    expect(service.has(id)).toBe(false);
    expect(store.getState().events.map((event) => event.kind)).toEqual([
      "permission.request",
      "permission.terminal",
    ]);
    expect(store.getState().events[1]?.payload).toMatchObject({
      permissionId: id,
      status: "resolved",
    });
  });

  test("respond with approve_once resolves to approve_once", async () => {
    const { promise } = await createPending("approve_once");

    await expect(promise).resolves.toBe("approve_once");
  });

  test("respond with deny resolves to deny", async () => {
    const { promise } = await createPending("deny");

    await expect(promise).resolves.toBe("deny");
  });

  test("respond with approve_always resolves to approve_always", async () => {
    const { promise } = await createPending("approve_always");

    await expect(promise).resolves.toBe("approve_always");
  });

  test("respond to non-existent id returns false", () => {
    const service = new PermissionService();

    expect(service.respond("missing", "deny")).toBe(false);
  });

  test("abort signal triggers cleanup and resolves with timeout", async () => {
    const service = new PermissionService();
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceRoot = await createWorkspaceRoot();
    const store = createSessionStore(sessionId, workspaceRoot);
    const abortController = new AbortController();
    const promise = service.request(sessionId, workspaceRoot, request, store, abortController.signal);
    const event = store.getState().events.find((entry) => entry.kind === "permission.request");
    if (!event) {
      throw new Error("permission request event missing");
    }

    const payload = event.payload as {
      permissionId: string;
    };

    abortController.abort();
    await flushMicrotasks();

    await expect(promise).resolves.toBe("timeout");
    expect(service.has(payload.permissionId)).toBe(false);
    expect(service.respond(payload.permissionId, "approve_once")).toBe(false);
    expect(store.getState().events.map((event) => event.kind)).toEqual([
      "permission.request",
      "permission.terminal",
    ]);
    expect(store.getState().events[1]?.payload).toMatchObject({
      permissionId: payload.permissionId,
      status: "timeout",
    });
  });

  test("cleanup removes all entries", async () => {
    const service = new PermissionService();
    const sessionOne = `session-${crypto.randomUUID()}`;
    const sessionTwo = `session-${crypto.randomUUID()}`;
    const workspaceOne = await createWorkspaceRoot();
    const workspaceTwo = await createWorkspaceRoot();
    const storeOne = createSessionStore(sessionOne, workspaceOne);
    const storeTwo = createSessionStore(sessionTwo, workspaceTwo);
    const first = service.request(sessionOne, workspaceOne, request, storeOne);
    const second = service.request(sessionTwo, workspaceTwo, request, storeTwo);
    const firstEvent = storeOne.getState().events.find((entry) => entry.kind === "permission.request");
    const secondEvent = storeTwo.getState().events.find((entry) => entry.kind === "permission.request");
    if (!firstEvent || !secondEvent) {
      throw new Error("permission request event missing");
    }

    const firstId = (firstEvent.payload as { permissionId: string }).permissionId;
    const secondId = (secondEvent.payload as { permissionId: string }).permissionId;

    service.cleanup();

    expect(service.has(firstId)).toBe(false);
    expect(service.has(secondId)).toBe(false);
    await expect(first).resolves.toBe("timeout");
    await expect(second).resolves.toBe("timeout");
    expect(storeOne.getState().events[1]?.payload).toMatchObject({
      permissionId: firstId,
      status: "cancelled",
    });
    expect(storeTwo.getState().events[1]?.payload).toMatchObject({
      permissionId: secondId,
      status: "cancelled",
    });
  });

  test("cleanup with workspaceRoot only clears matching entries", async () => {
    const service = new PermissionService();
    const sessionId = `session-${crypto.randomUUID()}`;
    const workspaceA = await createWorkspaceRoot();
    const workspaceB = await createWorkspaceRoot();
    const storeA = createSessionStore(sessionId, workspaceA);
    const storeB = createSessionStore(sessionId, workspaceB);
    const first = service.request(sessionId, workspaceA, request, storeA);
    const second = service.request(sessionId, workspaceB, request, storeB);
    const firstEvent = storeA.getState().events.find((entry) => entry.kind === "permission.request");
    const secondEvent = storeB.getState().events.find((entry) => entry.kind === "permission.request");
    if (!firstEvent || !secondEvent) {
      throw new Error("permission request event missing");
    }

    const firstId = (firstEvent.payload as { permissionId: string }).permissionId;
    const secondId = (secondEvent.payload as { permissionId: string }).permissionId;

    service.cleanup(sessionId, workspaceA);

    expect(service.has(firstId)).toBe(false);
    expect(service.has(secondId)).toBe(true);
    await expect(first).resolves.toBe("timeout");
    expect(storeA.getState().events[1]?.payload).toMatchObject({
      permissionId: firstId,
      status: "cancelled",
    });

    expect(service.respond(secondId, "approve_once")).toBe(true);
    await expect(second).resolves.toBe("approve_once");
    expect(storeB.getState().events[1]?.payload).toMatchObject({
      permissionId: secondId,
      status: "resolved",
    });
  });
});

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});
