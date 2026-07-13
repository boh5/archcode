import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentRuntime } from "@archcode/agent-core";
import { ProjectRegistry, ProjectRuntimeActiveError, silentLogger } from "@archcode/agent-core";
import type { ProjectInfo } from "@archcode/agent-core";
import type { GlobalSSEEvent } from "@archcode/protocol";
import { createServerApp } from "../app";
import { globalEventBus } from "../events/global-event-bus";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "projects-routes");

function createTestRuntime(
  projectRegistry: ProjectRegistry,
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  return {
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    skillService: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    reconcileRegisteredProject: async () => undefined,
    startAutomationScheduler: async () => undefined,
    removeProject: async (projectSlug: string) => {
      const project = await projectRegistry.remove(projectSlug);
      if (project === undefined) return undefined;
      const createdAt = Date.now();
      return {
        project,
        snapshot: {
          sessionRuntime: {
            type: "session.runtime.snapshot",
            projectSlugs: [project.slug],
            families: [],
            createdAt,
          },
          hitl: {
            type: "hitl.snapshot",
            projectSlugs: [project.slug],
            projections: [],
            createdAt,
          },
        },
      };
    },
    listSessionRuntimeEvents: async () => [{
      type: "session.runtime.snapshot",
      projectSlugs: (await projectRegistry.list()).map((project) => project.slug),
      families: [],
      createdAt: Date.now(),
    }],
    listPendingHitlEvents: async () => [{
      type: "hitl.snapshot",
      projectSlugs: (await projectRegistry.list()).map((project) => project.slug),
      projections: [],
      createdAt: Date.now(),
    }],
    getProjectControlPlaneSnapshot: async (workspaceRoot: string, projectSlug: string) => {
      const project = await projectRegistry.get(projectSlug);
      if (project?.workspaceRoot !== workspaceRoot) throw new Error("project scope mismatch");
      const createdAt = Date.now();
      return {
        sessionRuntime: {
          type: "session.runtime.snapshot",
          projectSlugs: [projectSlug],
          families: [],
          createdAt,
        },
        hitl: {
          type: "hitl.snapshot",
          projectSlugs: [projectSlug],
          projections: [],
          createdAt,
        },
      };
    },
    subscribeHitlEvents: () => () => undefined,
    subscribeSessionRuntimeChanges: () => () => undefined,
    createSession: async () => ({ sessionId: "session", title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] }),
    getSessionFile: async (_workspaceRoot: string, sessionId: string) => ({ sessionId, title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] }),
    listSessions: async () => [],
    startSessionExecution: () => {
      throw new Error("not implemented");
    },
    stopSessionFamily: async () => undefined,
    abortAllSessionExecutions: async () => undefined,
    getSessionFamilyActivity: () => "idle",
    getSessionExecution: () => undefined,
    subscribeSessionEvents: () => () => undefined,
    deleteSession: async () => undefined,
    disposeSessionAgent: () => undefined,
    disposeAllSessionAgents: () => undefined,
    isSessionTombstoned: () => false,
    dispatchCommand: async () => null,
    notifyRuntimeShutdown: () => undefined,
    ...overrides,
  } as unknown as AgentRuntime;
}

async function makeWorkspace(name: string): Promise<string> {
  const workspaceRoot = join(tempRoot, "workspaces", name);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function createTestApp(testName: string) {
  const homeDir = join(tempRoot, "homes", testName);
  await mkdir(homeDir, { recursive: true });
  const runtime = createTestRuntime(new ProjectRegistry({ homeDir, logger: silentLogger }));
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

  test("POST publishes authoritative runtime and HITL snapshots for only the added project before returning", async () => {
    const homeDir = join(tempRoot, "homes", "control-plane-snapshot");
    await mkdir(homeDir, { recursive: true });
    const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
    const runtime = createTestRuntime(projectRegistry, {
      listSessionRuntimeEvents: async () => {
        throw new Error("must not scan unrelated projects");
      },
      listPendingHitlEvents: async () => {
        throw new Error("must not scan unrelated projects");
      },
      getProjectControlPlaneSnapshot: async () => ({
        sessionRuntime: {
          type: "session.runtime.snapshot",
          projectSlugs: ["alpha"],
          families: [{ projectSlug: "alpha", rootSessionId: "root-1", activity: "running" }],
          createdAt: 10,
        },
        hitl: {
          type: "hitl.snapshot",
          projectSlugs: ["alpha"],
          projections: [],
          createdAt: 11,
        },
      }),
    });
    const app = createServerApp(runtime, { dev: true }).app;
    const observed: GlobalSSEEvent[] = [];
    const unsubscribe = globalEventBus.subscribe((event) => observed.push(event));
    const workspaceRoot = await makeWorkspace("alpha-control-plane");

    try {
      const response = await app.request("/api/projects", {
        method: "POST",
        body: JSON.stringify({ workspaceRoot, name: "Alpha" }),
        headers: { "content-type": "application/json" },
      });

      expect(response.status).toBe(201);
      expect(observed).toEqual([
        {
          type: "session.runtime.snapshot",
          projectSlugs: ["alpha"],
          families: [{ projectSlug: "alpha", rootSessionId: "root-1", activity: "running" }],
          createdAt: 10,
        },
        {
          type: "hitl.snapshot",
          projectSlugs: ["alpha"],
          projections: [],
          createdAt: 11,
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("POST retries snapshot capture when a project live event races the first read", async () => {
    const homeDir = join(tempRoot, "homes", "control-plane-race");
    await mkdir(homeDir, { recursive: true });
    const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
    let running = false;
    const getProjectControlPlaneSnapshot = mock(async () => {
      const createdAt = Date.now();
      const snapshot = {
        sessionRuntime: {
          type: "session.runtime.snapshot" as const,
          projectSlugs: ["racing"],
          families: running
            ? [{ projectSlug: "racing", rootSessionId: "root-1", activity: "running" as const }]
            : [],
          createdAt,
        },
        hitl: {
          type: "hitl.snapshot" as const,
          projectSlugs: ["racing"],
          projections: [],
          createdAt,
        },
      };
      if (!running) {
        running = true;
        globalEventBus.emit({
          type: "session.runtime_changed",
          projectSlug: "racing",
          rootSessionId: "root-1",
          activity: "running",
          createdAt: Date.now(),
        });
      }
      return snapshot;
    });
    const runtime = createTestRuntime(projectRegistry, {
      getProjectControlPlaneSnapshot,
    });
    const app = createServerApp(runtime, { dev: true }).app;
    const observed: GlobalSSEEvent[] = [];
    const unsubscribe = globalEventBus.subscribe((event) => observed.push(event));
    const workspaceRoot = await makeWorkspace("racing-control-plane");

    try {
      const response = await app.request("/api/projects", {
        method: "POST",
        body: JSON.stringify({ workspaceRoot, name: "Racing" }),
        headers: { "content-type": "application/json" },
      });

      expect(response.status).toBe(201);
      expect(getProjectControlPlaneSnapshot).toHaveBeenCalledTimes(2);
      expect(observed.at(-2)).toMatchObject({
        type: "session.runtime.snapshot",
        projectSlugs: ["racing"],
        families: [{ projectSlug: "racing", rootSessionId: "root-1", activity: "running" }],
      });
      expect(observed.at(-1)).toMatchObject({ type: "hitl.snapshot", projectSlugs: ["racing"] });
    } finally {
      unsubscribe();
    }
  });

  test("POST rolls back a new registry entry when its authoritative snapshot cannot be published", async () => {
    const homeDir = join(tempRoot, "homes", "control-plane-failure");
    await mkdir(homeDir, { recursive: true });
    const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
    const runtime = createTestRuntime(projectRegistry, {
      getProjectControlPlaneSnapshot: async () => {
        throw new Error("snapshot failed");
      },
    });
    const app = createServerApp(runtime, { dev: true }).app;
    const workspaceRoot = await makeWorkspace("failed-control-plane");

    const response = await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot, name: "Failed" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(500);
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("POST /api/projects rejects unknown body fields", async () => {
    const app = await createTestApp("create-project-unknown-field");
    const workspaceRoot = await makeWorkspace("unknown-field");

    const res = await app.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot, unexpected: true }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
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

    const events: GlobalSSEEvent[] = [];
    const unsubscribe = globalEventBus.subscribe((event) => events.push(event));
    const res = await app.request(`/api/projects/${project.slug}`, { method: "DELETE" });
    unsubscribe();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(events).toEqual([
      expect.objectContaining({ type: "session.runtime.snapshot", projectSlugs: [project.slug], families: [] }),
      expect.objectContaining({ type: "hitl.snapshot", projectSlugs: [project.slug], projections: [] }),
    ]);
  });

  test("DELETE /api/projects/:slug rejects active Session families without unregistering", async () => {
    const homeDir = join(tempRoot, "homes", "delete-active");
    await mkdir(homeDir, { recursive: true });
    const registry = new ProjectRegistry({ homeDir, logger: silentLogger });
    const workspaceRoot = await makeWorkspace("delete-active");
    const project = await registry.add({ workspaceRoot, name: "Delete Active" });
    const runtime = createTestRuntime(registry, {
      removeProject: async () => {
        throw new ProjectRuntimeActiveError(project.slug, [{ rootSessionId: "root-running", activity: "running" }]);
      },
    });
    const app = createServerApp(runtime, { dev: true }).app;

    const res = await app.request(`/api/projects/${project.slug}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "PROJECT_REMOVE_CONFLICT",
        message: `Project "${project.slug}" has active Session families and cannot be removed`,
        details: {
          projectSlug: project.slug,
          activeFamilies: [{ rootSessionId: "root-running", activity: "running" }],
        },
      },
    });
    expect(await registry.get(project.slug)).toEqual(project);
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

  test("PATCH /api/projects/:slug rejects unknown body fields", async () => {
    const app = await createTestApp("patch-project-unknown-field");

    const res = await app.request("/api/projects/missing", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed", unexpected: true }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
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
