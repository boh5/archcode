import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SpecraRuntime } from "@specra/agent-core";
import { ProjectRegistry } from "@specra/agent-core";
import type { ProjectInfo } from "@specra/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "projects-routes");

function createTestRuntime(projectRegistry: ProjectRegistry): SpecraRuntime {
  return {
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    skillService: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    createSession: async () => ({ sessionId: "session", title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] }),
    getSessionFile: async (_workspaceRoot: string, sessionId: string) => ({ sessionId, title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] }),
    listSessions: async () => [],
    submitAgentJob: () => {
      throw new Error("not implemented");
    },
    abortAgentJob: () => false,
    abortAgentJobAndWait: async () => undefined,
    abortAllAgentJobs: async () => undefined,
    isAgentJobRunning: () => false,
    getAgentJob: () => undefined,
    subscribeSessionEvents: () => () => undefined,
    deleteSession: async () => undefined,
    disposeSessionAgent: () => undefined,
    disposeAllSessionAgents: () => undefined,
    isSessionTombstoned: () => false,
    dispatchCommand: async () => null,
    requestPermission: async () => "timeout",
    respondPermission: () => false,
    requestQuestion: async () => ({ isError: true, reason: "Cancelled" }),
    respondQuestion: () => false,
    cleanupDeferredSession: () => undefined,
    notifyRuntimeShutdown: () => undefined,
  } as unknown as SpecraRuntime;
}

async function makeWorkspace(name: string): Promise<string> {
  const workspaceRoot = join(tempRoot, "workspaces", name);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function createTestApp(testName: string) {
  const homeDir = join(tempRoot, "homes", testName);
  await mkdir(homeDir, { recursive: true });
  const runtime = createTestRuntime(new ProjectRegistry({ homeDir }));
  return createServerApp(runtime, { dev: true }).app;
}

describe("projects routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("GET /api/projects returns empty list initially", async () => {
    const app = await createTestApp("empty-list");

    const res = await app.request("/api/projects");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [] });
  });

  test("POST /api/projects with valid workspaceRoot creates project", async () => {
    const app = await createTestApp("create-project");
    const workspaceRoot = await makeWorkspace("alpha");

    const res = await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot, name: "Alpha Project" }),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as ProjectInfo;

    expect(res.status).toBe(201);
    expect(body).toMatchObject({
      slug: "alpha-project",
      name: "Alpha Project",
      workspaceRoot,
    });
    expect(typeof body.addedAt).toBe("string");
  });

  test("POST /api/projects with missing workspaceRoot returns 400 BadRequestError", async () => {
    const app = await createTestApp("missing-workspace");

    const res = await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Missing Workspace" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "workspaceRoot is required" },
    });
  });

  test("POST /api/projects with non-existent directory returns 400", async () => {
    const app = await createTestApp("missing-directory");
    const workspaceRoot = join(tempRoot, "workspaces", "missing");

    const res = await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Project workspaceRoot must be an existing directory",
        details: { workspaceRoot },
      },
    });
  });

  test("GET /api/projects after add returns the project", async () => {
    const app = await createTestApp("list-after-add");
    const workspaceRoot = await makeWorkspace("listed");

    await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot, name: "Listed Project" }),
      headers: { "content-type": "application/json" },
    });
    const res = await app.request("/api/projects");
    const body = (await res.json()) as { projects: ProjectInfo[] };

    expect(res.status).toBe(200);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      slug: "listed-project",
      name: "Listed Project",
      workspaceRoot,
    });
  });

  test("DELETE /api/projects/:slug returns ok", async () => {
    const app = await createTestApp("delete-project");
    const workspaceRoot = await makeWorkspace("delete-me");
    const created = await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot, name: "Delete Me" }),
      headers: { "content-type": "application/json" },
    });
    const project = (await created.json()) as ProjectInfo;

    const res = await app.request(`/api/projects/${project.slug}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("DELETE /api/projects/:slug for non-existent slug returns ok", async () => {
    const app = await createTestApp("delete-missing");

    const res = await app.request("/api/projects/missing", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("PATCH /api/projects/:slug updates the project display name", async () => {
    const app = await createTestApp("patch-project");
    const workspaceRoot = await makeWorkspace("patch-me");
    const created = await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot, name: "Original" }),
      headers: { "content-type": "application/json" },
    });
    const project = (await created.json()) as ProjectInfo;

    const res = await app.request(`/api/projects/${project.slug}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as ProjectInfo;

    expect(res.status).toBe(200);
    expect(body).toEqual({ ...project, name: "Renamed" });
  });

  test("PATCH /api/projects/:slug trims the project display name", async () => {
    const app = await createTestApp("patch-trimmed-project");
    const workspaceRoot = await makeWorkspace("patch-trimmed");
    const created = await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot, name: "Original" }),
      headers: { "content-type": "application/json" },
    });
    const project = (await created.json()) as ProjectInfo;

    const res = await app.request(`/api/projects/${project.slug}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "  Trimmed Name  " }),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as ProjectInfo;

    expect(res.status).toBe(200);
    expect(body.name).toBe("Trimmed Name");
    expect(body.slug).toBe(project.slug);
    expect(body.workspaceRoot).toBe(workspaceRoot);
  });

  test("PATCH /api/projects/:slug with missing name returns 400", async () => {
    const app = await createTestApp("patch-missing-name");

    const res = await app.request("/api/projects/missing", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "name is required" },
    });
  });

  test("PATCH /api/projects/:slug with empty name returns 400", async () => {
    const app = await createTestApp("patch-empty-name");

    const res = await app.request("/api/projects/missing", {
      method: "PATCH",
      body: JSON.stringify({ name: "   " }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "name must not be empty" },
    });
  });

  test("PATCH /api/projects/:slug with too-long name returns 400", async () => {
    const app = await createTestApp("patch-too-long-name");

    const res = await app.request("/api/projects/missing", {
      method: "PATCH",
      body: JSON.stringify({ name: "a".repeat(81) }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "name must be 80 characters or fewer" },
    });
  });

  test("PATCH /api/projects/:slug for non-existent slug returns 404 ProjectNotFoundError", async () => {
    const app = await createTestApp("patch-missing-project");

    const res = await app.request("/api/projects/missing", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project not found: missing" },
    });
  });

  test("POST /api/projects/:slug/touch updates lastOpenedAt", async () => {
    const app = await createTestApp("touch-project");
    const workspaceRoot = await makeWorkspace("touch-me");
    const created = await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot, name: "Touch Me" }),
      headers: { "content-type": "application/json" },
    });
    const project = (await created.json()) as ProjectInfo;

    const res = await app.request(`/api/projects/${project.slug}/touch`, { method: "POST" });
    const body = (await res.json()) as ProjectInfo;

    expect(res.status).toBe(200);
    expect(body.slug).toBe(project.slug);
    expect(typeof body.lastOpenedAt).toBe("string");
    expect(body.lastOpenedAt).not.toBe(project.lastOpenedAt);
  });

  test("POST /api/projects/:slug/touch for non-existent slug returns 404 ProjectNotFoundError", async () => {
    const app = await createTestApp("touch-missing");

    const res = await app.request("/api/projects/missing/touch", { method: "POST" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project not found: missing" },
    });
  });
});
