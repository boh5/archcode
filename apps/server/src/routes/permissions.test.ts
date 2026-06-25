import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { errorHandler } from "../error-handler";
import type { AgentRuntime } from "@archcode/agent-core";
import { PermissionService } from "../permission-service";
import { createPermissionRoutes } from "./permissions";

const PERMISSION_ID = "permission-1";

function createRuntime() {
  return {
    respondPermission: mock((id: string) => id === PERMISSION_ID),
  } as unknown as AgentRuntime;
}

function createTestApp(permissionService: PermissionService): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/permissions", createPermissionRoutes(permissionService));
  return app;
}

describe("permission routes", () => {
  test("POST valid response returns ok", async () => {
    const permissionService = new PermissionService(createRuntime());
    const app = createTestApp(permissionService);

    const res = await app.request(`/api/permissions/${PERMISSION_ID}`, {
      method: "POST",
      body: JSON.stringify({ response: "approve_once" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST invalid response returns 400", async () => {
    const permissionService = new PermissionService(createRuntime());
    const app = createTestApp(permissionService);

    const res = await app.request(`/api/permissions/${PERMISSION_ID}`, {
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
    const app = createTestApp(new PermissionService(createRuntime()));

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
    const permissionService = new PermissionService(createRuntime());
    const app = createTestApp(permissionService);

    const res = await app.request(`/api/permissions/${PERMISSION_ID}`, { method: "POST" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "Invalid JSON body" },
    });
  });
});
