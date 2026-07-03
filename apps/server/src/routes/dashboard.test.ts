import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectContextResolver, ProjectRegistry, silentLogger } from "@archcode/agent-core";
import type { AgentRuntime, LoopConfig, LoopState, ProjectInfo } from "@archcode/agent-core";
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
  const contextResolver = new ProjectContextResolver({
    logger: silentLogger,
    projectInfoFactory: async (workspaceRoot: string) => {
      const projects = await projectRegistry.list();
      return projects.find((p) => p.workspaceRoot === workspaceRoot);
    },
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
    requestPermission: mock(async () => "timeout"),
    respondPermission: mock(() => false),
    requestQuestion: mock(async () => ({ isError: true, reason: "Cancelled" })),
    respondQuestion: mock(() => false),
    cleanupDeferredSession: mock(() => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
    listLoops: mock(async (workspaceRoot: string) => {
      const context = await contextResolver.resolve(workspaceRoot);
      return await context.loopState.list(context.project.slug);
    }),
    readLoop: mock(async () => { throw new Error("not implemented"); }),
    createLoop: mock(async () => { throw new Error("not implemented"); }),
    updateLoop: mock(async () => { throw new Error("not implemented"); }),
    pauseLoop: mock(async () => { throw new Error("not implemented"); }),
    resumeLoop: mock(async () => { throw new Error("not implemented"); }),
    triggerLoopRun: mock(async () => undefined),
    readLoopRunLog: mock(async () => []),
    readLoopStateMarkdown: mock(async () => ""),
    startLoopSchedulers: mock(async () => undefined),
    stopLoopSchedulers: mock(() => undefined),
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

const LOOP_CONFIG: LoopConfig = {
  title: "Test loop",
  schedule: { kind: "interval", everyMs: 60_000 },
  runKind: "session",
  mode: "report",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 5 },
  taskPrompt: "Summarize local project state.",
};

async function createLoop(runtime: AgentRuntime, project: ProjectInfo, title: string): Promise<LoopState> {
  const context = await runtime.contextResolver.resolve(project.workspaceRoot);
  return await context.loopState.create(project.slug, { ...LOOP_CONFIG, title });
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

  test("GET /api/loops aggregates loops across registered projects", async () => {
    const { app, runtime } = await createTestApp("aggregate-loops");
    const firstProject = await addProject(runtime, "aggregate-loops", "Alpha Project");
    const secondProject = await addProject(runtime, "aggregate-loops", "Beta Project");
    const firstLoop = await createLoop(runtime, firstProject, "Alpha loop");
    const secondLoop = await createLoop(runtime, secondProject, "Beta loop");

    const res = await app.request("/api/loops");
    const body = await res.json() as {
      loops: Array<{
        loopId: string;
        title: string;
        status: string;
        currentRun?: unknown;
        lastRun?: unknown;
        nextRunAt?: number;
        runKind: string;
        mode: string;
        projectSlug: string;
        projectName: string;
      }>;
      errors?: Array<{ projectSlug: string; projectName: string; message: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.loops.map((l) => l.title).sort()).toEqual(["Alpha loop", "Beta loop"]);
    expect(body.loops).toContainEqual(expect.objectContaining({
      loopId: firstLoop.loopId,
      title: "Alpha loop",
      status: "active",
      runKind: "session",
      mode: "report",
      projectSlug: firstProject.slug,
      projectName: firstProject.name,
    }));
    expect(body.loops).toContainEqual(expect.objectContaining({
      loopId: secondLoop.loopId,
      title: "Beta loop",
      status: "active",
      runKind: "session",
      mode: "report",
      projectSlug: secondProject.slug,
      projectName: secondProject.name,
    }));
  });

  test("GET /api/loops?status=active returns active loops with run fields", async () => {
    const { app, runtime } = await createTestApp("active-loops");
    const project = await addProject(runtime, "active-loops", "Active Loop Project");
    const loop = await createLoop(runtime, project, "Active loop");

    // Record a completed run to populate lastRun
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const completedRunId = crypto.randomUUID();
    const completedAt = Date.now() - 60_000;
    await context.loopState.recordRunStart(loop.loopId, {
      runId: completedRunId,
      loopId: loop.loopId,
      status: "running",
      trigger: "interval",
      startedAt: completedAt - 10_000,
    });
    await context.loopState.recordRunFinish(loop.loopId, {
      runId: completedRunId,
      loopId: loop.loopId,
      status: "succeeded",
      trigger: "interval",
      startedAt: completedAt - 10_000,
      endedAt: completedAt,
    });

    // Record a new running run to populate currentRun
    const startedAt = Date.now();
    await context.loopState.recordRunStart(loop.loopId, {
      runId: crypto.randomUUID(),
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt,
    });

    const res = await app.request("/api/loops?status=active");
    const body = await res.json() as {
      loops: Array<{
        loopId: string;
        title: string;
        status: string;
        currentRun: { runId: string; status: string; startedAt: number };
        lastRun: { runId: string; status: string; startedAt: number; endedAt: number };
        nextRunAt: number;
        runKind: string;
        mode: string;
        projectSlug: string;
        projectName: string;
      }>;
    };

    expect(res.status).toBe(200);
    expect(body.loops).toHaveLength(1);
    const match = body.loops[0];
    expect(match.loopId).toBe(loop.loopId);
    expect(match.title).toBe("Active loop");
    expect(match.status).toBe("active");
    expect(match.runKind).toBe("session");
    expect(match.mode).toBe("report");
    expect(match.currentRun).toBeDefined();
    expect(match.currentRun.status).toBe("running");
    expect(match.currentRun.startedAt).toBe(startedAt);
    expect(match.lastRun).toBeDefined();
    expect(match.lastRun.status).toBe("succeeded");
    expect(match.lastRun.endedAt).toBe(completedAt);
    expect(match.nextRunAt).toBeGreaterThan(completedAt);
    expect(match.nextRunAt).toBeLessThan(completedAt + 120_000);
    expect(match.projectSlug).toBe(project.slug);
    expect(match.projectName).toBe(project.name);
  });

  test("GET /api/loops?status=active excludes disabled loops", async () => {
    const { app, runtime } = await createTestApp("active-excludes-disabled");
    const project = await addProject(runtime, "active-excludes-disabled", "Disabled Project");
    await createLoop(runtime, project, "Active loop");
    const disabledLoop = await createLoop(runtime, project, "Disabled loop");
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    await context.loopState.update(disabledLoop.loopId, { status: "disabled" });

    const res = await app.request("/api/loops?status=active");
    const body = await res.json() as {
      loops: Array<{ loopId: string; title: string; status: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.loops).toHaveLength(1);
    expect(body.loops[0].title).toBe("Active loop");
    expect(body.loops[0].status).toBe("active");
  });

  test("GET /api/loops?status=invalid returns 400", async () => {
    const { app } = await createTestApp("invalid-status");

    const res = await app.request("/api/loops?status=invalid");

    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code: string; message: string } };
    expect(body.error?.code).toBe("BAD_REQUEST");
    expect(body.error?.message).toMatch(/active|valid/);
  });

  test("GET /api/loops excludes generatedStateSummary and readinessScore", async () => {
    const { app, runtime } = await createTestApp("loop-no-rich-fields");
    const project = await addProject(runtime, "loop-no-rich-fields", "No Rich Project");
    await createLoop(runtime, project, "No rich loop");

    const res = await app.request("/api/loops");
    const body = await res.json() as {
      loops: Array<Record<string, unknown>>;
    };

    expect(res.status).toBe(200);
    expect(body.loops).toHaveLength(1);
    const loop = body.loops[0];
    expect(loop).not.toHaveProperty("generatedStateSummary");
    expect(loop).not.toHaveProperty("readinessScore");
    expect(loop).not.toHaveProperty("config");
    expect(loop).not.toHaveProperty("stateVersion");
    expect(loop).not.toHaveProperty("runCount");
  });

  test("GET /api/loops reports corrupt project loop data as partial failure metadata", async () => {
    const { app, runtime } = await createTestApp("loop-partial-failure");
    const healthyProject = await addProject(runtime, "loop-partial-failure", "Healthy Project");
    const corruptProject = await addProject(runtime, "loop-partial-failure", "Corrupt Project");
    await createLoop(runtime, healthyProject, "Healthy loop");
    // Write invalid JSON into a loop state file to corrupt it
    const corruptLoopDir = join(corruptProject.workspaceRoot, ".archcode", "loops", "00000000-0000-0000-0000-000000000001");
    await mkdir(corruptLoopDir, { recursive: true });
    await Bun.write(join(corruptLoopDir, "state.json"), "{ invalid json");

    const res = await app.request("/api/loops");
    const body = await res.json() as {
      loops: Array<{ loopId: string; title: string }>;
      errors?: Array<{ projectSlug: string; projectName: string; message: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.loops).toHaveLength(1);
    expect(body.loops[0]).toMatchObject({ title: "Healthy loop", projectSlug: healthyProject.slug, projectName: healthyProject.name });
    expect(body.errors).toContainEqual(expect.objectContaining({
      projectSlug: corruptProject.slug,
      projectName: corruptProject.name,
    }));
  });
});
