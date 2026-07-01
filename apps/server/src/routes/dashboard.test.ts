import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectContextResolver, ProjectRegistry, silentLogger } from "@archcode/agent-core";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import type { DoneCondition, GoalState } from "@archcode/protocol";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "dashboard-routes");

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

async function createGoal(runtime: AgentRuntime, project: ProjectInfo, title: string): Promise<GoalState> {
  const context = await runtime.contextResolver.resolve(project.workspaceRoot);
  return await context.goalState.create(
    project.slug,
    title,
    "tester",
    [doneCondition],
    { maxRetries: 2, backoffMs: 100, escalateOnFailure: true },
    ["after_plan"],
    "reviewer",
  );
}

describe("dashboard routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("GET /api/goals aggregates active goals across registered projects", async () => {
    const { app, runtime } = await createTestApp("aggregate-active");
    const firstProject = await addProject(runtime, "aggregate-active", "Alpha Project");
    const secondProject = await addProject(runtime, "aggregate-active", "Beta Project");
    const firstGoal = await createGoal(runtime, firstProject, "Alpha goal");
    const secondGoal = await createGoal(runtime, secondProject, "Beta goal");
    await (await runtime.contextResolver.resolve(firstProject.workspaceRoot)).goalState.lock(firstGoal.id, "planner");
    await (await runtime.contextResolver.resolve(firstProject.workspaceRoot)).goalState.transitionStatus(firstGoal.id, "running");
    await (await runtime.contextResolver.resolve(secondProject.workspaceRoot)).goalState.lock(secondGoal.id, "planner");
    await (await runtime.contextResolver.resolve(secondProject.workspaceRoot)).goalState.transitionStatus(secondGoal.id, "running");

    const res = await app.request("/api/goals?status=active");
    const body = await res.json() as { goals: Array<GoalState & { projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.goals.map((goal) => goal.title).sort()).toEqual(["Alpha goal", "Beta goal"]);
    expect(body.goals).toContainEqual(expect.objectContaining({ id: firstGoal.id, projectSlug: firstProject.slug, projectName: firstProject.name }));
    expect(body.goals).toContainEqual(expect.objectContaining({ id: secondGoal.id, projectSlug: secondProject.slug, projectName: secondProject.name }));
  });

  test("GET /api/goals supports explicit status filter", async () => {
    const { app, runtime } = await createTestApp("status-filter");
    const project = await addProject(runtime, "status-filter", "Status Project");
    const draftGoal = await createGoal(runtime, project, "Draft goal");
    const lockedGoal = await createGoal(runtime, project, "Locked goal");
    await (await runtime.contextResolver.resolve(project.workspaceRoot)).goalState.lock(lockedGoal.id, "planner");

    const res = await app.request("/api/goals?status=draft");
    const body = await res.json() as { goals: Array<GoalState & { projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.goals).toHaveLength(1);
    expect(body.goals[0]).toMatchObject({ id: draftGoal.id, title: "Draft goal", projectSlug: project.slug, projectName: project.name });
  });

  test("GET /api/goals skips corrupt project goal data as partial failure", async () => {
    const { app, runtime } = await createTestApp("partial-failure");
    const healthyProject = await addProject(runtime, "partial-failure", "Healthy Project");
    const corruptProject = await addProject(runtime, "partial-failure", "Corrupt Project");
    const healthyGoal = await createGoal(runtime, healthyProject, "Healthy goal");
    await mkdir(join(corruptProject.workspaceRoot, ".archcode", "goals", "not-a-uuid"), { recursive: true });

    const res = await app.request("/api/goals?status=draft");
    const body = await res.json() as { goals: Array<GoalState & { projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.goals).toHaveLength(1);
    expect(body.goals[0]).toMatchObject({ id: healthyGoal.id, projectSlug: healthyProject.slug, projectName: healthyProject.name });
  });
});
