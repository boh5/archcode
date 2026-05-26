import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { errorHandler } from "../error-handler";
import { SessionStoreManager } from "@specra/agent-core";
import { PermissionService } from "../permission-service";
import { createPermissionRoutes } from "./permissions";

const tmpRoots: string[] = [];
const manager = new SessionStoreManager();

function createTestApp(permissionService: PermissionService): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/permissions", createPermissionRoutes(permissionService));
  return app;
}

async function createWorkspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specra-permissions-routes-"));
  tmpRoots.push(root);
  return root;
}

async function createPermission(permissionService: PermissionService): Promise<string> {
  const sessionId = `session-${crypto.randomUUID()}`;
  const workspaceRoot = await createWorkspaceRoot();
  const store = manager.create(sessionId, workspaceRoot);
  void permissionService.request(
    sessionId,
    workspaceRoot,
    {
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
      description: "Confirm tool",
    },
    store,
  );

  const event = store.getState().events.find((entry) => entry.kind === "permission.request");
  if (!event) {
    throw new Error("permission request event missing");
  }

  return (event.payload as { permissionId: string }).permissionId;
}

describe("permission routes", () => {
  afterEach(() => {
    manager.clearAll();
  });

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

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});
