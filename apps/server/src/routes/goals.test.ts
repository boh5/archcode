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
    startSessionExecution: mock((input: { workspaceRoot: string; sessionId: string }) => ({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      agentName: "orchestrator",
      origin: "user_message",
      abortController: new AbortController(),
      promise: Promise.resolve(),
      executionToken: Symbol("test-execution"),
      startedAt: Date.now(),
    })),
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
    expect(running.status).toBe("locked");
    expect(running.mainSessionId).toBe("main-session");
    expect(running.childSessionIds).toEqual(["child-a"]);
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).toHaveBeenCalledTimes(1);
    expect(runtime.startSessionExecution).toHaveBeenCalledWith({
      slug: project.slug,
      workspaceRoot: project.workspaceRoot,
      sessionId: "main-session",
      userMessage: expect.stringContaining(`Goal ID: ${created.id}`),
    });

    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const persisted = await context.goalState.read(created.id);
    expect(persisted).toMatchObject({ status: "locked", mainSessionId: "main-session" });
  });

  test("POST run without body creates a main session and starts orchestrator execution", async () => {
    const { app, project, runtime } = await createTestApp("run-creates-session");
    const created = await createGoal(app, project.slug, "Execute the plan");
    await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "planner-session" }),
      headers: { "content-type": "application/json" },
    });
    (runtime.createSession as ReturnType<typeof mock>).mockImplementation(async () => ({
      sessionId: "created-main-session",
      title: null,
      createdAt: Date.now(),
      messages: [],
      steps: [],
      todos: [],
      reminders: [],
    }));

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    const reserved = await runRes.json() as GoalState;

    expect(runRes.status).toBe(200);
    expect(reserved.status).toBe("locked");
    expect(reserved.mainSessionId).toBe("created-main-session");
    expect(runtime.createSession).toHaveBeenCalledTimes(1);
    expect(runtime.createSession).toHaveBeenCalledWith(project.workspaceRoot, {
      goalId: created.id,
      sessionRole: "main",
      title: created.title,
    });
    expect(runtime.startSessionExecution).toHaveBeenCalledTimes(1);
    expect(runtime.startSessionExecution).toHaveBeenCalledWith({
      slug: project.slug,
      workspaceRoot: project.workspaceRoot,
      sessionId: "created-main-session",
      userMessage: expect.stringContaining("Your first action must be calling goal_run"),
    });

    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const persisted = await context.goalState.read(created.id);
    expect(persisted.mainSessionId).toBe("created-main-session");
  });

  test("POST run reuses an active reserved session without mutating goal", async () => {
    const { app, project, runtime } = await createTestApp("run-active-conflict");
    const created = await createGoal(app, project.slug);
    await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "planner-session" }),
      headers: { "content-type": "application/json" },
    });
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    await context.goalState.updateSessionIds(created.id, "busy-session");
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation(() => true);

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: "busy-session" }),
      headers: { "content-type": "application/json" },
    });

    expect(runRes.status).toBe(200);
    expect(await runRes.json()).toMatchObject({ status: "locked", mainSessionId: "busy-session" });
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();

    const persisted = await context.goalState.read(created.id);
    expect(persisted).toMatchObject({ status: "locked", mainSessionId: "busy-session" });
  });

  test("POST run start failure leaves goal locked and records lastError", async () => {
    const { app, project, runtime } = await createTestApp("run-start-failure-pauses");
    const created = await createGoal(app, project.slug);
    await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "planner-session" }),
      headers: { "content-type": "application/json" },
    });
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation(() => false);
    (runtime.startSessionExecution as ReturnType<typeof mock>).mockImplementation(() => {
      throw new Error("boom");
    });

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: "start-fails-session" }),
      headers: { "content-type": "application/json" },
    });

    expect(runRes.status).toBe(500);
    expect(runtime.startSessionExecution).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "start-fails-session" }));

    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const persisted = await context.goalState.read(created.id);
    expect(persisted.status).toBe("locked");
    expect(persisted.mainSessionId).toBe("start-fails-session");
    expect(persisted.lastError).toBe("Goal run bootstrap could not start: boom");
  });

  test("POST run reuses reserved main session on duplicate requests", async () => {
    const { app, project, runtime } = await createTestApp("run-duplicate-reuses-session");
    const created = await createGoal(app, project.slug);
    await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "planner-session" }),
      headers: { "content-type": "application/json" },
    });
    (runtime.createSession as ReturnType<typeof mock>).mockImplementation(async () => ({
      sessionId: "created-main-session",
      title: null,
      createdAt: Date.now(),
      messages: [],
      steps: [],
      todos: [],
      reminders: [],
    }));

    const firstRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    const secondRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(await firstRes.json()).toMatchObject({ status: "locked", mainSessionId: "created-main-session" });
    expect(await secondRes.json()).toMatchObject({ status: "locked", mainSessionId: "created-main-session" });
    expect(runtime.createSession).toHaveBeenCalledTimes(1);
    expect(runtime.startSessionExecution).toHaveBeenCalledTimes(2);
  });

  test("POST run rejects malformed JSON instead of treating it as empty body", async () => {
    const { app, project } = await createTestApp("run-malformed-json");
    const created = await createGoal(app, project.slug);
    await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "planner-session" }),
      headers: { "content-type": "application/json" },
    });

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, {
      method: "POST",
      body: "{bad json",
      headers: { "content-type": "application/json" },
    });

    expect(runRes.status).toBe(400);
    expect(await runRes.json()).toEqual({ error: { code: "BAD_REQUEST", message: "Request body must be valid JSON" } });
  });

  test("POST create rejects malformed done condition params", async () => {
    const { app, project } = await createTestApp("strict-done-condition");

    const res = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        title: "Bad condition",
        doneConditions: [{ id: "artifact", kind: "file_exists", params: {} }],
        retryPolicy: { maxRetries: 2, backoffMs: 100, escalateOnFailure: true },
        approvalPoints: [],
        reviewerAgent: "reviewer",
        author: "tester",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
  });

  test("POST create accepts grep_empty done condition", async () => {
    const { app, project } = await createTestApp("grep-empty-condition");

    const res = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        title: "No TODOs",
        doneConditions: [{ id: "no-todos", kind: "grep_empty", params: { pattern: "TODO", path: "src" } }],
        retryPolicy: { maxRetries: 2, backoffMs: 100, escalateOnFailure: true },
        approvalPoints: [],
        reviewerAgent: "reviewer",
        author: "tester",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ doneConditions: [{ id: "no-todos", kind: "grep_empty" }] });
  });

  test("POST create rejects too many done conditions", async () => {
    const { app, project } = await createTestApp("too-many-conditions");

    const res = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        title: "Too many conditions",
        doneConditions: Array.from({ length: 51 }, (_value, index) => ({
          id: `condition-${index}`,
          kind: "tests_pass",
          params: { command: "bun test" },
        })),
        retryPolicy: { maxRetries: 2, backoffMs: 100, escalateOnFailure: true },
        approvalPoints: [],
        reviewerAgent: "reviewer",
        author: "tester",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
  });

  test("POST create rejects oversized command timeout", async () => {
    const { app, project } = await createTestApp("oversized-command-timeout");

    const res = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        title: "Unsafe timeout",
        doneConditions: [{ id: "long-command", kind: "command_succeeds", params: { command: "pwd", timeoutMs: 600_001 } }],
        retryPolicy: { maxRetries: 2, backoffMs: 100, escalateOnFailure: true },
        approvalPoints: [],
        reviewerAgent: "reviewer",
        author: "tester",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
  });

  test("POST run keeps invalid transitions rejected and does not start execution", async () => {
    const { app, project, runtime } = await createTestApp("run-invalid-transition");
    const created = await createGoal(app, project.slug);

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });

    expect(runRes.status).toBe(409);
    expect(await runRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Invalid goal state for ${created.id}` },
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
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

  test("global goals include project metadata for each registered project", async () => {
    const { app, project, runtime } = await createTestApp("global-project-metadata");
    const otherWorkspaceRoot = resolve(tempRoot, "workspaces", "global-project-metadata-other");
    await mkdir(otherWorkspaceRoot, { recursive: true });
    const otherProject = await runtime.projectRegistry.add({ workspaceRoot: otherWorkspaceRoot, name: "global-project-metadata-other" });

    const firstGoal = await createGoal(app, project.slug, "First active goal");
    const otherGoal = await createGoal(app, otherProject.slug, "Other active goal");
    await app.request(`/api/projects/${project.slug}/goals/${firstGoal.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "planner" }),
      headers: { "content-type": "application/json" },
    });
    await app.request(`/api/projects/${project.slug}/goals/${firstGoal.id}/run`, { method: "POST" });
    await app.request(`/api/projects/${otherProject.slug}/goals/${otherGoal.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "planner" }),
      headers: { "content-type": "application/json" },
    });
    await app.request(`/api/projects/${otherProject.slug}/goals/${otherGoal.id}/run`, { method: "POST" });

    const res = await app.request("/api/goals?status=active");
    const body = await res.json() as { goals: Array<GoalState & { projectSlug: string; projectName: string }> };

    expect(res.status).toBe(200);
    expect(body.goals).toContainEqual(expect.objectContaining({ id: firstGoal.id, projectSlug: project.slug, projectName: project.name }));
    expect(body.goals).toContainEqual(expect.objectContaining({ id: otherGoal.id, projectSlug: otherProject.slug, projectName: otherProject.name }));
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

  test("project-scoped route returns 404 for a goal from another workspace", async () => {
    const { app, project, runtime } = await createTestApp("foreign-goal-read");
    const otherWorkspaceRoot = resolve(tempRoot, "workspaces", "foreign-goal-read-other");
    await mkdir(otherWorkspaceRoot, { recursive: true });
    const otherProject = await runtime.projectRegistry.add({ workspaceRoot: otherWorkspaceRoot, name: "foreign-goal-read-other" });
    const firstGoal = await createGoal(app, project.slug, "First workspace only");

    const res = await app.request(`/api/projects/${otherProject.slug}/goals/${firstGoal.id}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: `Goal not found: ${firstGoal.id}` },
    });
  });

  test("artifacts list/read returns canonical metadata and markdown content", async () => {
    const { app, project, runtime } = await createTestApp("artifacts-list-read");
    const goal = await createGoal(app, project.slug, "Artifact API");
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    await context.goalArtifacts.writeArtifact(goal, "plan.md", "# Plan\n\n- Step one", { agentName: "plan" });

    const listRes = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/artifacts`);
    const listBody = await listRes.json() as { artifacts: Array<{ name: string; path: string; mediaType: string; sha256?: string }> };
    const readRes = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/artifacts/plan.md`);
    const readBody = await readRes.json() as { artifact: { name: string; path: string; mediaType: string }; content: string };

    expect(listRes.status).toBe(200);
    expect(listBody.artifacts).toHaveLength(1);
    expect(listBody.artifacts[0]).toMatchObject({
      name: "plan.md",
      path: `.archcode/goals/${goal.id}/artifacts/plan.md`,
      mediaType: "text/markdown",
    });
    expect(listBody.artifacts[0].sha256).toBeString();

    expect(readRes.status).toBe(200);
    expect(readBody).toMatchObject({
      artifact: { name: "plan.md", path: `.archcode/goals/${goal.id}/artifacts/plan.md`, mediaType: "text/markdown" },
      content: "# Plan\n\n- Step one\n",
    });
  });

  test("artifacts route validates project scope, canonical names, and exposes no edit endpoint", async () => {
    const { app, project, runtime } = await createTestApp("artifacts-boundaries");
    const otherWorkspaceRoot = resolve(tempRoot, "workspaces", "artifacts-boundaries-other");
    await mkdir(otherWorkspaceRoot, { recursive: true });
    const otherProject = await runtime.projectRegistry.add({ workspaceRoot: otherWorkspaceRoot, name: "artifacts-boundaries-other" });
    const goal = await createGoal(app, project.slug, "Artifact boundaries");
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    await context.goalArtifacts.writeArtifact(goal, "plan.md", "# Plan", { agentName: "plan" });

    const foreignList = await app.request(`/api/projects/${otherProject.slug}/goals/${goal.id}/artifacts`);
    const traversalRead = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/artifacts/..%2Fplan.md`);
    const noncanonicalRead = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/artifacts/plan-v2.md`);
    const editAttempt = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/artifacts/plan.md`, {
      method: "PATCH",
      body: JSON.stringify({ content: "# Hacked" }),
      headers: { "content-type": "application/json" },
    });

    expect(foreignList.status).toBe(404);
    expect(await foreignList.json()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: `Goal not found: ${goal.id}` },
    });
    expect(traversalRead.status).toBe(400);
    expect(await traversalRead.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "artifactName must be a canonical Goal artifact name" },
    });
    expect(noncanonicalRead.status).toBe(400);
    expect(editAttempt.status).toBe(404);
    expect(await context.goalArtifacts.readArtifact(goal.id, "plan.md")).toBe("# Plan\n");
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
    const { app, project, runtime } = await createTestApp("actions");
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

    const resumeRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    const resumed = await resumeRes.json() as GoalState;
    expect(resumeRes.status).toBe(200);
    expect(resumed.status).toBe("paused");
    expect(resumed.mainSessionId).toBeString();

    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    await context.goalState.transitionStatus(created.id, "running");
    await context.goalState.transitionStatus(created.id, "failed");

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: "retry-session" }),
      headers: { "content-type": "application/json" },
    });
    const retried = await retryRes.json() as GoalState;
    expect(retryRes.status).toBe(200);
    expect(retried.status).toBe("failed");
    expect(retried.retryCount).toBe(0);
    expect(retried.mainSessionId).toBe("retry-session");
    expect(runtime.startSessionExecution).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "retry-session",
      userMessage: expect.stringContaining("goal_retry"),
    }));

    const escalateRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/escalate`, { method: "POST" });
    const escalated = await escalateRes.json() as GoalState;
    expect(escalateRes.status).toBe(200);
    expect(escalated.status).toBe("escalated");
  });

  test("POST retry rejects a different requested session when an active retry session is reserved", async () => {
    const { app, project, runtime } = await createTestApp("retry-active-reservation-mismatch");
    const created = await createGoal(app, project.slug);
    await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "locker" }),
      headers: { "content-type": "application/json" },
    });
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    await context.goalState.transitionStatus(created.id, "running");
    await context.goalState.transitionStatus(created.id, "failed");
    await context.goalState.updateSessionIds(created.id, "active-retry-session");
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation((_workspaceRoot: string, sessionId: string) => sessionId === "active-retry-session");

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: "other-retry-session" }),
      headers: { "content-type": "application/json" },
    });

    expect(retryRes.status).toBe(409);
    expect(await retryRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Goal ${created.id} is already reserved for session active-retry-session` },
    });
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
    expect(await context.goalState.read(created.id)).toMatchObject({ status: "failed", mainSessionId: "active-retry-session" });
  });

  test("cancel rejects draft and failed goals so run cannot bypass lock or retry", async () => {
    const { app, project, runtime } = await createTestApp("cancel-invalid-sources");
    const draft = await createGoal(app, project.slug, "Draft cannot pause");

    const draftCancelRes = await app.request(`/api/projects/${project.slug}/goals/${draft.id}/cancel`, { method: "POST" });
    const draftRunRes = await app.request(`/api/projects/${project.slug}/goals/${draft.id}/run`, { method: "POST" });

    expect(draftCancelRes.status).toBe(409);
    expect(draftRunRes.status).toBe(409);

    const failed = await createGoal(app, project.slug, "Failed cannot pause");
    await app.request(`/api/projects/${project.slug}/goals/${failed.id}/lock`, {
      method: "POST",
      body: JSON.stringify({ lockedBy: "locker" }),
      headers: { "content-type": "application/json" },
    });
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    await context.goalState.transitionStatus(failed.id, "running");
    await context.goalState.transitionStatus(failed.id, "failed");

    const failedCancelRes = await app.request(`/api/projects/${project.slug}/goals/${failed.id}/cancel`, { method: "POST" });
    const failedRunRes = await app.request(`/api/projects/${project.slug}/goals/${failed.id}/run`, { method: "POST" });

    expect(failedCancelRes.status).toBe(409);
    expect(failedRunRes.status).toBe(409);
    expect(runtime.createSession).not.toHaveBeenCalledWith(project.workspaceRoot, expect.objectContaining({ goalId: draft.id }));
    expect(runtime.createSession).not.toHaveBeenCalledWith(project.workspaceRoot, expect.objectContaining({ goalId: failed.id }));
  });
});
