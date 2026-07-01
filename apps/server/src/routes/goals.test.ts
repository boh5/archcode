import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ProjectContextResolver, ProjectRegistry, silentLogger } from "@archcode/agent-core";
import type { AgentRuntime } from "@archcode/agent-core";
import type { DoneCondition, GoalState } from "@archcode/protocol";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "goals-routes");

const doneCondition: DoneCondition = {
  id: "typecheck",
  kind: "typecheck_pass",
  required: true,
  params: { command: "bun run typecheck" },
};

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
  const workspaceRoot = resolve(tempRoot, "workspaces", testName);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const project = await projectRegistry.add({ workspaceRoot, name: testName });
  const runtime = createTestRuntime(projectRegistry);

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
    runtime,
    workspaceRoot,
  };
}

async function createGoal(app: ReturnType<typeof createServerApp>["app"], slug: string, title = "Ship Goal routes"): Promise<GoalState> {
  const res = await app.request(`/api/projects/${slug}/goals`, {
    method: "POST",
    body: JSON.stringify({
      title,
      doneConditions: [doneCondition],
      retryPolicy: { maxRetries: 2, backoffMs: 100, escalateOnFailure: true },
      approvalPoints: ["after_plan"],
      reviewerAgent: "reviewer",
      author: "tester",
    }),
    headers: { "content-type": "application/json" },
  });

  expect(res.status).toBe(201);
  return await res.json() as GoalState;
}

describe("goals routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("POST lock run lifecycle uses project goal state", async () => {
    const { app, project, runtime } = await createTestApp("lifecycle");

    const created = await createGoal(app, project.slug);
    expect(created.projectId).toBe(project.slug);
    expect(created.status).toBe("draft");

    const lockRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "planner-session" }),
      headers: { "content-type": "application/json" },
    });
    const locked = await lockRes.json() as GoalState;
    expect(lockRes.status).toBe(200);
    expect(locked.status).toBe("locked");
    expect(locked.lockedBy).toBe("planner-session");

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: "main-session", childSessionIds: ["child-a"] }),
      headers: { "content-type": "application/json" },
    });
    const running = await runRes.json() as GoalState;
    expect(runRes.status).toBe(200);
    expect(running.status).toBe("running");
    expect(running.mainSessionId).toBe("main-session");
    expect(running.childSessionIds).toEqual(["child-a"]);

    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const persisted = await context.goalState.read(created.id);
    expect(persisted).toMatchObject({ status: "running" });
  });

  test("PATCH after lock returns 409", async () => {
    const { app, project } = await createTestApp("patch-after-lock");
    const created = await createGoal(app, project.slug);
    await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "locker" }),
      headers: { "content-type": "application/json" },
    });

    const res = await app.request(`/api/projects/${project.slug}/goals/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Too late" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Goal ${created.id} is locked; generic patch is only allowed while draft` },
    });
  });

  test("goals are isolated by project workspace", async () => {
    const { app, project, runtime } = await createTestApp("cross-project");
    const otherWorkspaceRoot = resolve(tempRoot, "workspaces", "cross-project-other");
    await mkdir(otherWorkspaceRoot, { recursive: true });
    const otherProject = await runtime.projectRegistry.add({ workspaceRoot: otherWorkspaceRoot, name: "cross-project-other" });

    const firstGoal = await createGoal(app, project.slug, "First workspace");
    const otherGoal = await createGoal(app, otherProject.slug, "Other workspace");

    const firstRes = await app.request(`/api/projects/${project.slug}/goals`);
    const otherRes = await app.request(`/api/projects/${otherProject.slug}/goals`);
    const firstBody = await firstRes.json() as { goals: GoalState[] };
    const otherBody = await otherRes.json() as { goals: GoalState[] };

    expect(firstBody.goals.map((goal) => goal.id)).toEqual([firstGoal.id]);
    expect(otherBody.goals.map((goal) => goal.id)).toEqual([otherGoal.id]);
  });

  test("GET list supports status filter", async () => {
    const { app, project } = await createTestApp("status-filter");
    const draft = await createGoal(app, project.slug, "Draft goal");
    const locked = await createGoal(app, project.slug, "Locked goal");
    await app.request(`/api/projects/${project.slug}/goals/${locked.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "locker" }),
      headers: { "content-type": "application/json" },
    });

    const res = await app.request(`/api/projects/${project.slug}/goals?status=draft`);
    const body = await res.json() as { goals: GoalState[] };

    expect(res.status).toBe(200);
    expect(body.goals.map((goal) => goal.id)).toEqual([draft.id]);
  });

  test("GET missing goal returns 404", async () => {
    const { app, project } = await createTestApp("missing-goal");
    const missingGoalId = crypto.randomUUID();

    const res = await app.request(`/api/projects/${project.slug}/goals/${missingGoalId}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: `Goal not found: ${missingGoalId}` },
    });
  });

  test("invalid goal id path returns 400", async () => {
    const { app, project } = await createTestApp("invalid-goal-id");

    const res = await app.request(`/api/projects/${project.slug}/goals/not-a-uuid`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "goalId must be a UUID" },
    });
  });

  test("retry escalate and cancel endpoints mutate via goal state", async () => {
    const { app, project } = await createTestApp("actions");
    const created = await createGoal(app, project.slug);
    await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "locker" }),
      headers: { "content-type": "application/json" },
    });
    await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });

    const cancelRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/cancel`, { method: "POST" });
    const cancelled = await cancelRes.json() as GoalState;
    expect(cancelRes.status).toBe(200);
    expect(cancelled.status).toBe("paused");

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: "retry-session" }),
      headers: { "content-type": "application/json" },
    });
    const retried = await retryRes.json() as GoalState;
    expect(retryRes.status).toBe(200);
    expect(retried.status).toBe("running");
    expect(retried.retryCount).toBe(1);
    expect(retried.phase).toBe("plan");
    expect(retried.mainSessionId).toBe("retry-session");

    await app.request(`/api/projects/${project.slug}/goals/${created.id}/cancel`, { method: "POST" });
    const escalateRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/escalate`, { method: "POST" });
    const escalated = await escalateRes.json() as GoalState;
    expect(escalateRes.status).toBe(200);
    expect(escalated.status).toBe("escalated");
  });
});
