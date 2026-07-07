import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ProjectContextResolver, ProjectRegistry, silentLogger } from "@archcode/agent-core";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "hitl-routes");

function createTestRuntime(projectRegistry: ProjectRegistry): AgentRuntime {
  const contextResolver = new ProjectContextResolver({
    projectInfoFactory: (workspaceRoot) => projectRegistry.getByWorkspace(workspaceRoot),
    logger: silentLogger,
  });

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
    { projectSlug: context.project.slug, goalId, source: "test" },
  );
  const [request] = context.hitl.listPending(project.slug, goalId);
  expect(request).toBeDefined();
  return { context, request: request!, responsePromise };
}

async function requestBudgetApproval(runtime: AgentRuntime, project: ProjectInfo, sessionId: string, goalId = "goal-budget") {
  const context = await runtime.contextResolver.resolve(project.workspaceRoot);
  const responsePromise = context.hitl.request(
    sessionId,
    "approval",
    {
      kind: "approval",
      action: "approve_budget",
      context: {
        goalId,
        approvalPoint: "approval_budget_1",
        apiKey: "sk-test-secret-budget",
      },
      title: "Approve budget apiKey=sk-test-secret-budget",
      message: "Budget approval requires human confirmation with token sk-test-secret-budget",
    },
    {
      projectSlug: context.project.slug,
      goalId,
      source: "goal.approval.approval_budget_1",
      approvalPoint: "approval_budget_1",
    },
  );
  const [request] = context.hitl.listPending(project.slug, goalId);
  expect(request).toBeDefined();
  return { context, request: request!, responsePromise };
}

function expectHitlListIsDisplaySafe(body: unknown) {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain('"payload"');
  expect(serialized).not.toContain("sk-test-secret-budget");
  expect(serialized).toContain('"displayPayload"');
  expect(serialized).toContain("[REDACTED]");
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

  test("GET /api/hitl exposes display-safe pending HITL without raw payload secrets", async () => {
    const { app, runtime } = await createTestApp("global-redacted-pending");
    const project = await addProject(runtime, "global-redacted-pending", "Test Project");
    const pending = await requestBudgetApproval(runtime, project, "session-budget-global");

    const res = await app.request("/api/hitl?status=pending");
    const body = await res.json() as { hitl: Array<{ hitlId: string; displayPayload?: unknown; payload?: unknown }> };

    expect(res.status).toBe(200);
    expect(body.hitl).toHaveLength(1);
    expect(body.hitl[0]?.hitlId).toBe(pending.request.hitlId);
    expect((body.hitl[0]?.displayPayload as { redacted?: boolean } | undefined)?.redacted).toBe(true);
    expect(body.hitl[0]).not.toHaveProperty("payload");
    expectHitlListIsDisplaySafe(body);

    pending.context.hitl.cancel(pending.request.hitlId, "test cleanup", project.slug);
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

  test("GET /api/projects/:slug/hitl exposes display-safe pending HITL without raw payload secrets", async () => {
    const { app, runtime } = await createTestApp("project-redacted-pending");
    const project = await addProject(runtime, "project-redacted-pending", "Test Project");
    const pending = await requestBudgetApproval(runtime, project, "session-budget-project");

    const res = await app.request(`/api/projects/${project.slug}/hitl`);
    const body = await res.json() as { hitl: Array<{ hitlId: string; displayPayload?: unknown; payload?: unknown }> };

    expect(res.status).toBe(200);
    expect(body.hitl).toHaveLength(1);
    expect(body.hitl[0]?.hitlId).toBe(pending.request.hitlId);
    expect((body.hitl[0]?.displayPayload as { redacted?: boolean } | undefined)?.redacted).toBe(true);
    expect(body.hitl[0]).not.toHaveProperty("payload");
    expectHitlListIsDisplaySafe(body);

    pending.context.hitl.cancel(pending.request.hitlId, "test cleanup", project.slug);
  });

  test("POST /api/hitl/:id/respond rejects global HITL mutation", async () => {
    const { app, runtime } = await createTestApp("respond");
    const project = await addProject(runtime, "respond", "Respond Project");
    const pending = await requestHitl(runtime, project, "session-respond");

    const res = await app.request(`/api/hitl/${pending.request.hitlId}/respond`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", comment: "Looks good" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(pending.context.hitl.listPending(project.slug)).toEqual([
      expect.objectContaining({ hitlId: pending.request.hitlId, status: "pending" }),
    ]);
    pending.context.hitl.cancel(pending.request.hitlId, "test cleanup", project.slug);
  });

  test("POST /api/hitl/:id/cancel rejects global HITL mutation", async () => {
    const { app, runtime } = await createTestApp("cancel");
    const project = await addProject(runtime, "cancel", "Cancel Project");
    const pending = await requestHitl(runtime, project, "session-cancel");

    const res = await app.request(`/api/hitl/${pending.request.hitlId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "No longer needed" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(pending.context.hitl.listPending(project.slug)).toHaveLength(1);
    pending.context.hitl.cancel(pending.request.hitlId, "test cleanup", project.slug);
  });

  test("POST /api/projects/:slug/hitl/:id/respond resolves only that project's durable HITL", async () => {
    const { app, runtime } = await createTestApp("project-respond");
    const project = await addProject(runtime, "project-respond", "Respond Project");
    const pending = await requestHitl(runtime, project, "session-project-respond");

    const res = await app.request(`/api/projects/${project.slug}/hitl/${pending.request.hitlId}/respond`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", comment: "Project scoped" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await pending.responsePromise).toMatchObject({
      hitlId: pending.request.hitlId,
      status: "resolved",
      response: { decision: "approved", comment: "Project scoped" },
    });
  });

  test("POST /api/projects/test-project/hitl/approval_budget_1/respond resolves the matching approval point", async () => {
    const { app, runtime } = await createTestApp("approval-budget-respond");
    const project = await addProject(runtime, "approval-budget-respond", "Test Project");
    expect(project.slug).toBe("test-project");
    const pending = await requestBudgetApproval(runtime, project, "session-budget-respond", "goal-budget-respond");

    expect(pending.request.hitlId).not.toBe("approval_budget_1");
    expect(pending.request.trigger.approvalPoint).toBe("approval_budget_1");
    expect(pending.request.approvalKey).toBe(`${project.slug}:goal-budget-respond:session-budget-respond:approval_point:approval_budget_1`);

    const res = await app.request("/api/projects/test-project/hitl/approval_budget_1/respond", {
      method: "POST",
      body: JSON.stringify({ decision: "approved", comment: "Budget approved" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hitlId: pending.request.hitlId });
    expect(await pending.responsePromise).toMatchObject({
      hitlId: pending.request.hitlId,
      status: "resolved",
      response: { decision: "approved", comment: "Budget approved" },
    });
  });

  test("project budget approval queue is display-safe and resolves by approval point", async () => {
    const { app, runtime } = await createTestApp("budget-approval-daily-use");
    const project = await addProject(runtime, "budget-approval-daily-use", "Test Project");
    expect(project.slug).toBe("test-project");
    const pending = await requestBudgetApproval(runtime, project, "session-budget-daily-use", "goal-budget-daily-use");

    const listRes = await app.request(`/api/projects/${project.slug}/hitl`);
    const listBody = await listRes.json() as { hitl: Array<{ hitlId: string; displayPayload?: { title?: string; fields?: Array<{ label: string; value: string }>; redacted?: boolean }; payload?: unknown; approvalKey?: string }> };
    const item = listBody.hitl[0];

    expect(listRes.status).toBe(200);
    expect(item?.hitlId).toBe(pending.request.hitlId);
    expect(item?.displayPayload?.redacted).toBe(true);
    expect(item?.displayPayload?.title).toContain("[REDACTED]");
    expect(item?.displayPayload?.fields?.some((field) => field.value.includes("[REDACTED]"))).toBe(true);
    expect(item).not.toHaveProperty("payload");
    expectHitlListIsDisplaySafe(listBody);

    const respondRes = await app.request(`/api/projects/${project.slug}/hitl/approval_budget_1/respond`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", comment: "Budget approved from dashboard" }),
      headers: { "content-type": "application/json" },
    });

    expect(respondRes.status).toBe(200);
    expect(await respondRes.json()).toEqual({ ok: true, hitlId: pending.request.hitlId });
    expect(await pending.responsePromise).toMatchObject({
      hitlId: pending.request.hitlId,
      status: "resolved",
      response: { decision: "approved", comment: "Budget approved from dashboard" },
    });
    const afterRes = await app.request(`/api/projects/${project.slug}/hitl`);
    expect((await afterRes.json() as { hitl: unknown[] }).hitl).toEqual([]);
  });

  test("project-scoped HITL routes use registry slug even when project name differs from workspace basename", async () => {
    const { app, runtime } = await createTestApp("registry-slug");
    const project = await addProject(runtime, "registry-slug", "Project With Spaces");
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);

    expect(context.project.slug).toBe(project.slug);
    const pending = await requestHitl(runtime, project, "session-registry-slug");

    const listRes = await app.request(`/api/projects/${project.slug}/hitl`);
    const listBody = await listRes.json() as { hitl: Array<{ hitlId: string; projectSlug: string }> };
    expect(listBody.hitl).toContainEqual(expect.objectContaining({ hitlId: pending.request.hitlId, projectSlug: project.slug }));

    const respondRes = await app.request(`/api/projects/${project.slug}/hitl/${pending.request.hitlId}/respond`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
      headers: { "content-type": "application/json" },
    });
    expect(respondRes.status).toBe(200);
    expect(await pending.responsePromise).toMatchObject({ status: "resolved" });
  });

  test("POST /api/projects/:slug/hitl/:id/respond rejects wrong project without mutating HITL", async () => {
    const { app, runtime } = await createTestApp("project-wrong-respond");
    const firstProject = await addProject(runtime, "project-wrong-respond", "Alpha Project");
    const secondProject = await addProject(runtime, "project-wrong-respond", "Beta Project");
    const pending = await requestHitl(runtime, firstProject, "session-alpha");

    const res = await app.request(`/api/projects/${secondProject.slug}/hitl/${pending.request.hitlId}/respond`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(pending.context.hitl.listPending(firstProject.slug)).toEqual([
      expect.objectContaining({ hitlId: pending.request.hitlId, status: "pending" }),
    ]);
    pending.context.hitl.cancel(pending.request.hitlId, "test cleanup", firstProject.slug);
  });

  test("POST /api/projects/:slug/hitl/:id/cancel rejects wrong project without mutating HITL", async () => {
    const { app, runtime } = await createTestApp("project-wrong-cancel");
    const firstProject = await addProject(runtime, "project-wrong-cancel", "Alpha Project");
    const secondProject = await addProject(runtime, "project-wrong-cancel", "Beta Project");
    const pending = await requestHitl(runtime, firstProject, "session-alpha");

    const res = await app.request(`/api/projects/${secondProject.slug}/hitl/${pending.request.hitlId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "Wrong project" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(pending.context.hitl.listPending(firstProject.slug)).toEqual([
      expect.objectContaining({ hitlId: pending.request.hitlId, status: "pending" }),
    ]);
    pending.context.hitl.cancel(pending.request.hitlId, "test cleanup", firstProject.slug);
  });

  test("POST /api/projects/:slug/hitl/approval_budget_1/respond rejects wrong project without mutating matching approval", async () => {
    const { app, runtime } = await createTestApp("approval-budget-wrong-project");
    const firstProject = await addProject(runtime, "approval-budget-wrong-project", "Test Project");
    const secondProject = await addProject(runtime, "approval-budget-wrong-project", "Other Project");
    const pending = await requestBudgetApproval(runtime, firstProject, "session-budget-wrong", "goal-budget-wrong");

    const res = await app.request(`/api/projects/${secondProject.slug}/hitl/approval_budget_1/respond`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(pending.context.hitl.listPending(firstProject.slug)).toEqual([
      expect.objectContaining({
        hitlId: pending.request.hitlId,
        status: "pending",
        trigger: expect.objectContaining({ approvalPoint: "approval_budget_1" }),
      }),
    ]);
    pending.context.hitl.cancel(pending.request.hitlId, "test cleanup", firstProject.slug);
  });

  test("POST /api/projects/:slug/hitl/:id/cancel resolves only that project's durable HITL", async () => {
    const { app, runtime } = await createTestApp("project-cancel");
    const project = await addProject(runtime, "project-cancel", "Cancel Project");
    const pending = await requestHitl(runtime, project, "session-project-cancel");

    const res = await app.request(`/api/projects/${project.slug}/hitl/${pending.request.hitlId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "Project cancel" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await pending.responsePromise).toMatchObject({
      hitlId: pending.request.hitlId,
      status: "cancelled",
      reason: "Project cancel",
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
