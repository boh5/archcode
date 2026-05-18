import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { errorHandler } from "../error-handler";
import { EventRing } from "../event-ring";
import { PermissionService } from "../permission-service";
import { createPermissionRoutes } from "./permissions";

function createTestApp(permissionService: PermissionService): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/permissions", createPermissionRoutes(permissionService));
  return app;
}

async function createPermission(permissionService: PermissionService): Promise<string> {
  const ring = new EventRing();
  void permissionService.request(
    "session-1",
    {
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
      description: "Confirm tool",
    },
    ring,
  );

  return (JSON.parse(ring.since(0)[0].data) as { id: string }).id;
}

describe("permission routes", () => {
  test("POST valid response returns ok", async () => {
    const permissionService = new PermissionService();
    const app = createTestApp(permissionService);
    const id = await createPermission(permissionService);

    const res = await app.request(`/api/permissions/${id}`, {
      method: "POST",
      body: JSON.stringify({ response: "approve_once" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST invalid response returns 400", async () => {
    const permissionService = new PermissionService();
    const app = createTestApp(permissionService);
    const id = await createPermission(permissionService);

    const res = await app.request(`/api/permissions/${id}`, {
      method: "POST",
      body: JSON.stringify({ response: "approve" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "response must be approve_once, approve_always, or deny" },
    });
  });

  test("POST non-existent id returns 400", async () => {
    const app = createTestApp(new PermissionService());

    const res = await app.request("/api/permissions/missing", {
      method: "POST",
      body: JSON.stringify({ response: "deny" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "Permission request not found or already resolved" },
    });
  });

  test("POST missing body returns 400", async () => {
    const permissionService = new PermissionService();
    const app = createTestApp(permissionService);
    const id = await createPermission(permissionService);

    const res = await app.request(`/api/permissions/${id}`, { method: "POST" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "Invalid JSON body" },
    });
  });
});
