import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ProjectContextResolver, ProjectRegistry, silentLogger } from "@archcode/agent-core";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "hitl-routes");

function createTestRuntime(projectRegistry: ProjectRegistry): AgentRuntime {
  const contextResolver = new ProjectContextResolver({ logger: silentLogger });

  return {
    projectRegistry,
    contextResolver,
    warnings: [],
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    skillService: undefined,
    hitl: undefined,
    createSession: mock(async () => ({ sessionId: crypto.randomUUID(), title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] })),
    getSessionFile: mock(async (_workspaceRoot: string, sessionId: string) => ({ sessionId, title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] })),
    listSessions: mock(async () => []),
    startSessionExecution: mock(() => {
      throw new Error("not implemented");
    }),
    abortSessionExecution: mock(() => false),
    abortSessionExecutionAndWait: mock(async () => undefined),
    abortAllSessionExecutions: mock(async () => undefined),
    isSessionExecutionRunning: mock(() => false),
    getSessionExecution: mock(() => undefined),
    subscribeSessionEvents: mock(() => () => undefined),
    deleteSession: mock(async () => undefined),
    listSessionTree: mock(async () => ({ root: null, sessions: [] })),
    disposeSessionAgent: mock(() => undefined),
    disposeAllSessionAgents: mock(() => undefined),
    isSessionTombstoned: mock(() => false),
    dispatchCommand: mock(async () => null),
    requestPermission: mock(async () => "timeout"),
    respondPermission: mock(() => false),
    requestQuestion: mock(async () => ({ isError: true, reason: "Cancelled" })),
    respondQuestion: mock(() => false),
    cleanupDeferredSession: mock(() => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
  } as unknown as AgentRuntime;
}

async function createTestApp(testName: string) {
  const homeDir = resolve(tempRoot, "homes", testName);
  await mkdir(homeDir, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const runtime = createTestRuntime(projectRegistry);

  return {
    app: createServerApp(runtime, { dev: true }).app,
    runtime,
  };
}

async function addProject(runtime: AgentRuntime, testName: string, name: string): Promise<ProjectInfo> {
  const workspaceRoot = resolve(tempRoot, "workspaces", testName, name);
  await mkdir(workspaceRoot, { recursive: true });
  return await runtime.projectRegistry.add({ workspaceRoot, name });
}

async function requestHitl(runtime: AgentRuntime, project: ProjectInfo, sessionId: string, goalId = crypto.randomUUID()) {
  const context = await runtime.contextResolver.resolve(project.workspaceRoot);
  const responsePromise = context.hitl.request(
    sessionId,
    "approval",
    { kind: "approval", action: "continue", context: { goalId }, title: "Continue?", message: "Approve next step" },
    { projectSlug: project.slug, goalId, source: "test" },
  );
  const [request] = context.hitl.listPending(project.slug, goalId);
  expect(request).toBeDefined();
  return { context, request: request!, responsePromise };
}

describe("hitl routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("GET /api/hitl aggregates pending HITL across projects with project metadata", async () => {
    const { app, runtime } = await createTestApp("global-pending");
    const firstProject = await addProject(runtime, "global-pending", "Alpha Project");
    const secondProject = await addProject(runtime, "global-pending", "Beta Project");
    const first = await requestHitl(runtime, firstProject, "session-alpha");
    const second = await requestHitl(runtime, secondProject, "session-beta");

    const res = await app.request("/api/hitl?status=pending");
    const body = await res.json() as { hitl: Array<{ hitlId: string; projectSlug: string; projectName: string; status: string }> };

    expect(res.status).toBe(200);
    expect(body.hitl).toHaveLength(2);
    expect(body.hitl).toContainEqual(expect.objectContaining({ hitlId: first.request.hitlId, projectSlug: firstProject.slug, projectName: firstProject.name, status: "pending" }));
    expect(body.hitl).toContainEqual(expect.objectContaining({ hitlId: second.request.hitlId, projectSlug: secondProject.slug, projectName: secondProject.name, status: "pending" }));

    first.context.hitl.cancel(first.request.hitlId);
    second.context.hitl.cancel(second.request.hitlId);
  });

  test("GET /api/projects/:slug/hitl lists pending HITL for one project", async () => {
    const { app, runtime } = await createTestApp("project-pending");
    const firstProject = await addProject(runtime, "project-pending", "Alpha Project");
    const secondProject = await addProject(runtime, "project-pending", "Beta Project");
    const first = await requestHitl(runtime, firstProject, "session-alpha");
    const second = await requestHitl(runtime, secondProject, "session-beta");

    const res = await app.request(`/api/projects/${firstProject.slug}/hitl`);
    const body = await res.json() as { hitl: Array<{ hitlId: string; projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.hitl).toHaveLength(1);
    expect(body.hitl[0]).toMatchObject({ hitlId: first.request.hitlId, projectSlug: firstProject.slug, projectName: firstProject.name });

    first.context.hitl.cancel(first.request.hitlId);
    second.context.hitl.cancel(second.request.hitlId);
  });

  test("POST /api/hitl/:id/respond resolves the pending HITL request", async () => {
    const { app, runtime } = await createTestApp("respond");
    const project = await addProject(runtime, "respond", "Respond Project");
    const pending = await requestHitl(runtime, project, "session-respond");

    const res = await app.request(`/api/hitl/${pending.request.hitlId}/respond`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", comment: "Looks good" }),
      headers: { "content-type": "application/json" },
    });
    const body = await res.json() as { ok: boolean; hitlId: string };
    const resolved = await pending.responsePromise;

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, hitlId: pending.request.hitlId });
    expect(resolved).toEqual({
      hitlId: pending.request.hitlId,
      kind: "approval",
      status: "resolved",
      response: { decision: "approve", comment: "Looks good" },
    });
    expect(pending.context.hitl.listPending(project.slug)).toHaveLength(0);
  });

  test("POST /api/hitl/:id/cancel resolves the pending HITL request as cancelled", async () => {
    const { app, runtime } = await createTestApp("cancel");
    const project = await addProject(runtime, "cancel", "Cancel Project");
    const pending = await requestHitl(runtime, project, "session-cancel");

    const res = await app.request(`/api/hitl/${pending.request.hitlId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "No longer needed" }),
      headers: { "content-type": "application/json" },
    });
    const resolved = await pending.responsePromise;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hitlId: pending.request.hitlId });
    expect(resolved).toEqual({
      hitlId: pending.request.hitlId,
      kind: "approval",
      status: "cancelled",
      reason: "No longer needed",
    });
  });

  test("POST /api/hitl/:id/respond returns 404 when HITL request is not found", async () => {
    const { app } = await createTestApp("missing");

    const res = await app.request("/api/hitl/missing/respond", {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
  });
});
