import { describe, expect, test } from "bun:test";
import type { ToolConfirmationRequest, ToolConfirmationResult } from "../tools/types";
import { EventRing } from "./event-ring";
import { PermissionService } from "./permission-service";

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

async function createPending(response?: ToolConfirmationResult) {
  const service = new PermissionService();
  const ring = new EventRing();
  const promise = service.request("session-1", request, ring);
  const event = ring.since(0)[0];
  const payload = JSON.parse(event.data) as { id: string; sessionId: string };

  if (response) {
    service.respond(payload.id, response);
  }

  return { service, ring, promise, id: payload.id, payload };
}

describe("PermissionService", () => {
  test("request creates Deferred, respond resolves it", async () => {
    const { service, promise, id, payload } = await createPending();

    expect(service.has(id)).toBe(true);
    expect(payload.sessionId).toBe("session-1");
    expect(payload.id).toBe(id);
    expect(payload).toMatchObject(request);

    expect(service.respond(id, "approve_once")).toBe(true);
    await expect(promise).resolves.toBe("approve_once");
    expect(service.has(id)).toBe(false);
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
    const ring = new EventRing();
    const abortController = new AbortController();
    const promise = service.request("session-1", request, ring, abortController.signal);
    const payload = JSON.parse(ring.since(0)[0].data) as { id: string };

    abortController.abort();
    await flushMicrotasks();

    await expect(promise).resolves.toBe("timeout");
    expect(service.has(payload.id)).toBe(false);
    expect(service.respond(payload.id, "approve_once")).toBe(false);
  });

  test("cleanup removes all entries", async () => {
    const service = new PermissionService();
    const ringOne = new EventRing();
    const ringTwo = new EventRing();
    const first = service.request("session-1", request, ringOne);
    const second = service.request("session-2", request, ringTwo);
    const firstId = (JSON.parse(ringOne.since(0)[0].data) as { id: string }).id;
    const secondId = (JSON.parse(ringTwo.since(0)[0].data) as { id: string }).id;

    service.cleanup();

    expect(service.has(firstId)).toBe(false);
    expect(service.has(secondId)).toBe(false);
    await expect(first).resolves.toBe("timeout");
    await expect(second).resolves.toBe("timeout");
  });

  test("cleanup with workspaceRoot only clears matching entries", async () => {
    const service = new PermissionService();
    const workspaceA = "/tmp/specra-workspace-a";
    const workspaceB = "/tmp/specra-workspace-b";
    const ringA = new EventRing();
    const ringB = new EventRing();
    const first = service.request("same-session", workspaceA, request, ringA);
    const second = service.request("same-session", workspaceB, request, ringB);
    const firstId = (JSON.parse(ringA.since(0)[0].data) as { id: string }).id;
    const secondId = (JSON.parse(ringB.since(0)[0].data) as { id: string }).id;

    service.cleanup("same-session", workspaceA);

    expect(service.has(firstId)).toBe(false);
    expect(service.has(secondId)).toBe(true);
    await expect(first).resolves.toBe("timeout");

    expect(service.respond(secondId, "approve_once")).toBe(true);
    await expect(second).resolves.toBe("approve_once");
  });
});
