import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { GoalState, GoalStatus } from "@archcode/protocol";
import { GoalRunner, GoalWorkspaceService, WorktreeService, type WorktreeCreateResult } from "@archcode/agent-core";
import { errorHandler } from "../error-handler";
import { createGoalsRoutes } from "./goals";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "goals-routes");

type RouteRuntime = Parameters<typeof createGoalsRoutes>[0];

interface ProjectInfo {
  slug: string;
  name: string;
  workspaceRoot: string;
  addedAt: string;
}

interface RuntimeFixture {
  app: Hono;
  manager: FakeGoalStateManager;
  project: ProjectInfo;
  runtime: RouteRuntime;
  bindSession(sessionId: string, binding: TestSessionBinding): void;
}

interface TestSessionBinding {
  readonly goalId?: string;
  readonly sessionRole?: "main" | "plan" | "build" | "review" | "explore" | "librarian" | "standalone";
  readonly cwd?: string;
}

const providedMainSessionId = "11111111-1111-4111-8111-111111111111";
const providedChildSessionId = "22222222-2222-4222-8222-222222222222";
const createdMainSessionId = "33333333-3333-4333-8333-333333333333";
const retrySessionId = "44444444-4444-4444-8444-444444444444";
const activeRetrySessionId = "55555555-5555-4555-8555-555555555555";
const otherRetrySessionId = "66666666-6666-4666-8666-666666666666";
const otherGoalSessionId = "77777777-7777-4777-8777-777777777777";
const nonMainSessionId = "88888888-8888-4888-8888-888888888888";
const missingSessionId = "99999999-9999-4999-8999-999999999999";
const otherGoalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeGoalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalStateError";
  }
}

class FakeGoalTransitionError extends Error {
  constructor(goalId: string, from: GoalStatus, to: GoalStatus) {
    super(`Invalid goal transition ${from} -> ${to} for ${goalId}`);
    this.name = "GoalTransitionError";
  }
}

class FakeGoalReviewerAuthorizationError extends Error {
  constructor(public readonly goalId: string, message: string) {
    super(message);
    this.name = "GoalReviewerAuthorizationError";
  }
}

class FakeGoalReviewFinalizationError extends Error {
  constructor(public readonly goalId: string, message: string) {
    super(message);
    this.name = "GoalReviewFinalizationError";
  }
}

class FakeGoalNotFoundError extends Error {
  constructor(goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = "GoalNotFoundError";
  }
}

class FakeGoalStateManager {
  readonly #goals = new Map<string, GoalState>();
  readonly #now = new Date("2026-07-08T00:00:00.000Z").toISOString();
  #nextReadError: Error | undefined;

  async listGoals(projectId?: string): Promise<GoalState[]> {
    return [...this.#goals.values()].filter((goal) => projectId === undefined || goal.projectId === projectId);
  }

  async create(input: { readonly projectId: string; readonly title?: string | null; readonly objective: string; readonly acceptanceCriteria: string; readonly useWorktree?: boolean; readonly loopId?: string }): Promise<GoalState> {
    const goal: GoalState = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: input.title ?? null,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      useWorktree: input.useWorktree ?? false,
      ...(input.loopId === undefined ? {} : { loopId: input.loopId }),
      status: "draft",
      attempt: 1,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
      createdAt: this.#now,
      updatedAt: this.#now,
    };
    this.#goals.set(goal.id, goal);
    return goal;
  }

  async read(goalId: string): Promise<GoalState> {
    if (this.#nextReadError !== undefined) {
      const error = this.#nextReadError;
      this.#nextReadError = undefined;
      throw error;
    }
    const goal = this.#goals.get(goalId);
    if (goal === undefined) throw new FakeGoalNotFoundError(goalId);
    return goal;
  }

  async patchDraft(goalId: string, updates: Partial<Pick<GoalState, "objective" | "acceptanceCriteria" | "useWorktree">>): Promise<GoalState> {
    const goal = await this.read(goalId);
    if (goal.status !== "draft") {
      throw new FakeGoalStateError(`Goal ${goalId} is ${goal.status}; patch is only allowed while draft`);
    }
    return this.#update(goalId, { ...updates, updatedAt: this.#now });
  }

  async start(goalId: string, input: { readonly mainSessionId?: string } = {}): Promise<GoalState> {
    const goal = await this.read(goalId);
    if (goal.status !== "draft" && goal.status !== "running") {
      throw new FakeGoalTransitionError(goalId, goal.status, "running");
    }
    return this.#update(goalId, {
      status: "running",
      ...(input.mainSessionId === undefined ? {} : { mainSessionId: input.mainSessionId }),
      startedAt: goal.startedAt ?? this.#now,
      updatedAt: this.#now,
    });
  }

  async retry(goalId: string, input: { readonly mainSessionId?: string } = {}): Promise<GoalState> {
    const goal = await this.read(goalId);
    if (goal.status !== "not_done" && goal.status !== "failed" && goal.status !== "running") {
      throw new FakeGoalTransitionError(goalId, goal.status, "running");
    }
    return this.#update(goalId, {
      status: "running",
      attempt: goal.status === "running" ? goal.attempt : goal.attempt + 1,
      review: undefined,
      lastError: undefined,
      ...(input.mainSessionId === undefined ? {} : { mainSessionId: input.mainSessionId }),
      startedAt: goal.startedAt ?? this.#now,
      updatedAt: this.#now,
    });
  }

  async cancel(goalId: string): Promise<GoalState> {
    const goal = await this.read(goalId);
    if (goal.status === "done" || goal.status === "cancelled") {
      throw new FakeGoalTransitionError(goalId, goal.status, "cancelled");
    }
    return this.#update(goalId, { status: "cancelled", cancelledAt: this.#now, updatedAt: this.#now });
  }

  async setMainSession(goalId: string, mainSessionId: string): Promise<GoalState> {
    return this.#update(goalId, { mainSessionId, updatedAt: this.#now });
  }

  async addChildSession(goalId: string, childSessionId: string): Promise<GoalState> {
    const goal = await this.read(goalId);
    const childSessionIds = goal.childSessionIds.includes(childSessionId)
      ? goal.childSessionIds
      : [...goal.childSessionIds, childSessionId];
    return this.#update(goalId, { childSessionIds, updatedAt: this.#now });
  }

  async setWorktree(goalId: string, worktree: NonNullable<GoalState["worktree"]>): Promise<GoalState> {
    return this.#update(goalId, { worktree, useWorktree: true, updatedAt: this.#now });
  }

  async fail(goalId: string, error: Error | string): Promise<GoalState> {
    const normalized = error instanceof Error
      ? { name: error.name, message: error.message, at: this.#now }
      : { name: "Error", message: error, at: this.#now };
    return this.#update(goalId, {
      status: "failed",
      lastError: normalized,
      updatedAt: this.#now,
    });
  }

  async setStatus(goalId: string, status: GoalStatus): Promise<GoalState> {
    return this.#update(goalId, { status, updatedAt: this.#now });
  }

  async setReview(goalId: string): Promise<GoalState> {
    return this.#update(goalId, {
      status: "not_done",
      lastFailureSummary: "Reviewer found missing evidence.",
      review: {
        verdict: "NOT_DONE",
        summary: "More work is required.",
        evidenceRefs: [],
        reviewerSessionId: "reviewer-session",
        decidedAt: this.#now,
      },
      updatedAt: this.#now,
    });
  }

  failNextRead(error: Error): void {
    this.#nextReadError = error;
  }

  #update(goalId: string, updates: Partial<GoalState>): GoalState {
    const goal = this.#goals.get(goalId);
    if (goal === undefined) throw new FakeGoalNotFoundError(goalId);
    const updated = { ...goal, ...updates };
    this.#goals.set(goalId, updated);
    return updated;
  }
}

function createRuntime(
  project: ProjectInfo,
  manager: FakeGoalStateManager,
  sessionBindings: Map<string, TestSessionBinding>,
): RouteRuntime {
  const cancelOwner = mock(async (
    _owner: { projectSlug: string; ownerType: "session" | "goal"; ownerId: string },
    _reason: string,
  ) => []);
  const contextResolver = {
    resolve: mock(async () => ({ goalState: manager, hitl: { cancelOwner } })),
  };
  const abortSessionExecutionAndWait = mock(async (_workspaceRoot: string, _sessionId: string) => undefined);
  const isSessionExecutionRunning = mock((_workspaceRoot: string, _sessionId: string) => false);
  const listSessionTree = mock(async (_workspaceRoot: string, rootSessionId: string) => ({
    root: {
      session: { sessionId: rootSessionId, rootSessionId, title: null, createdAt: Date.now() },
      children: [],
    },
    diagnostics: [],
  }));
  const runtime = {
    projectRegistry: {
      get: mock(async (slug: string) => slug === project.slug ? project : undefined),
    },
    contextResolver,
    createSession: mock(async (_workspaceRoot: string, options?: TestSessionBinding) => {
      sessionBindings.set(createdMainSessionId, {
        ...(options?.goalId === undefined ? {} : { goalId: options.goalId }),
        sessionRole: options?.sessionRole ?? "main",
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      });
      return {
        sessionId: createdMainSessionId,
        title: null,
        createdAt: Date.now(),
        messages: [],
        steps: [],
        todos: [],
        reminders: [],
        ...(options?.goalId === undefined ? {} : { goalId: options.goalId }),
        sessionRole: options?.sessionRole ?? "main",
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      };
    }),
    getSessionFile: mock(async (_workspaceRoot: string, sessionId: string) => {
      if (sessionId === missingSessionId) throw new Error("Session not found");
      const binding = sessionBindings.get(sessionId) ?? {};
      return {
        sessionId,
        title: null,
        createdAt: Date.now(),
        messages: [],
        steps: [],
        todos: [],
        reminders: [],
        ...(binding.goalId === undefined ? {} : { goalId: binding.goalId }),
        ...(binding.sessionRole === undefined ? {} : { sessionRole: binding.sessionRole }),
        ...(binding.cwd === undefined ? {} : { cwd: binding.cwd }),
      };
    }),
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
    abortSessionExecutionAndWait,
    isSessionExecutionRunning,
    listSessionTree,
    cancelGoal: mock(async (workspaceRoot: string, goalId: string, request: { source: string; reason?: string }) => {
      const goal = await manager.read(goalId);
      if (request.source === "http" && goal.loopId !== undefined) {
        const error = new Error(`Goal ${goal.id} is owned by Loop ${goal.loopId} and must be resumed by its owning Loop`);
        error.name = "GoalCancellationError";
        throw error;
      }
      const sessionIds = new Set(goal.childSessionIds);
      if (goal.mainSessionId !== undefined) {
        sessionIds.add(goal.mainSessionId);
        await abortSessionExecutionAndWait(workspaceRoot, goal.mainSessionId);
        if (isSessionExecutionRunning(workspaceRoot, goal.mainSessionId)) {
          const error = new Error(`Goal ${goalId} cannot be cancelled until Session ${goal.mainSessionId} stops`);
          error.name = "GoalCancellationError";
          throw error;
        }
        const tree = await listSessionTree(workspaceRoot, goal.mainSessionId);
        sessionIds.add(tree.root.session.sessionId);
      }
      for (const sessionId of [...sessionIds].sort()) {
        await cancelOwner({ projectSlug: goal.projectId, ownerType: "session", ownerId: sessionId }, "goal_cancelled");
      }
      await cancelOwner({ projectSlug: goal.projectId, ownerType: "goal", ownerId: goal.id }, "goal_cancelled");
      return await manager.cancel(goalId);
    }),
    queueGoalTitleGeneration: mock(() => undefined),
  };
  return runtime as unknown as RouteRuntime;
}

async function createFixture(testName: string): Promise<RuntimeFixture> {
  const workspaceRoot = resolve(tempRoot, "workspaces", testName);
  await mkdir(workspaceRoot, { recursive: true });
  const project: ProjectInfo = {
    slug: testName,
    name: testName,
    workspaceRoot,
    addedAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
  };
  const manager = new FakeGoalStateManager();
  const sessionBindings = new Map<string, TestSessionBinding>([
    [otherGoalSessionId, { goalId: otherGoalId, sessionRole: "main" }],
    [nonMainSessionId, { goalId: otherGoalId, sessionRole: "explore" }],
  ]);
  const runtime = createRuntime(project, manager, sessionBindings);
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/projects", createGoalsRoutes(runtime));
  return {
    app,
    manager,
    project,
    runtime,
    bindSession: (sessionId, binding) => sessionBindings.set(sessionId, binding),
  };
}

async function postGoal(app: Hono, slug: string): Promise<GoalState> {
  const res = await app.request(`/api/projects/${slug}/goals`, {
    method: "POST",
    body: JSON.stringify({
      objective: "Expose a natural-language Goal contract from the server.",
      acceptanceCriteria: "The API accepts objective and acceptance criteria only.",
    }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  return await res.json() as GoalState;
}

function lastStartedUserMessage(runtime: RouteRuntime): string {
  const calls = (runtime.startSessionExecution as ReturnType<typeof mock>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const input = calls[calls.length - 1]?.[0] as { userMessage?: string } | undefined;
  expect(input?.userMessage).toBeString();
  return input?.userMessage ?? "";
}

function expectSimplifiedGoalShape(goal: Record<string, unknown>): void {
  expect(goal.title === null || typeof goal.title === "string").toBe(true);
  expect(goal.objective).toBeString();
  expect(goal.acceptanceCriteria).toBeString();
  expect(goal).not.toHaveProperty("doneConditions");
  expect(goal).not.toHaveProperty("retryPolicy");
  expect(goal).not.toHaveProperty("approvalPoints");
  expect(goal).not.toHaveProperty("reviewerAgent");
  expect(goal).not.toHaveProperty("author");
  expect(goal).not.toHaveProperty("artifacts");
  expect(JSON.stringify(goal)).not.toContain("plan.md");
  expect(JSON.stringify(goal)).not.toContain("/artifacts");
}

function expectPromptUsesNaturalLanguageOnly(message: string): void {
  expect(message).toContain("Objective:");
  expect(message).toContain("Expose a natural-language Goal contract from the server.");
  expect(message).toContain("Acceptance criteria:");
  expect(message).toContain("The API accepts objective and acceptance criteria only.");
  expect(message).not.toContain("DoneCondition");
  expect(message).not.toContain("Done Conditions");
  expect(message).not.toContain("doneConditions");
  expect(message).not.toContain("validation command");
  expect(message).not.toContain("command_succeeds");
  expect(message).not.toContain("typecheck_pass");
}

function expectPromptDoesNotRequestRedundantGoalClaim(message: string): void {
  expect(message).toContain("Runtime has already started and claimed");
  expect(message).not.toContain("Your first action must be calling goal_manage");
  expect(message).not.toContain("goal_manage with action:\"start\"");
  expect(message).not.toContain("goal_manage with action:\"retry\"");
}

describe("goals routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("POST create accepts only the simplified natural-language contract", async () => {
    const { app, project, runtime } = await createFixture("create-simplified");

    const goal = await postGoal(app, project.slug);

    expect(goal).toMatchObject({
      projectId: project.slug,
      title: null,
      objective: "Expose a natural-language Goal contract from the server.",
      acceptanceCriteria: "The API accepts objective and acceptance criteria only.",
      status: "draft",
      attempt: 1,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
    });
    expectSimplifiedGoalShape(goal as unknown as Record<string, unknown>);
    expect(runtime.queueGoalTitleGeneration).toHaveBeenCalledWith(project.workspaceRoot, goal.id);
  });

  test("POST create rejects old structured Goal payload fields with 400", async () => {
    const { app, project } = await createFixture("reject-old-payload");

    const res = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        title: "Old Goal",
        objective: "This should be rejected.",
        acceptanceCriteria: "Old fields are not allowed.",
        doneConditions: [{ id: "typecheck", kind: "typecheck_pass", params: { command: "bun run typecheck" } }],
        retryPolicy: { maxRetries: 2, backoffMs: 100, escalateOnFailure: true },
        approvalPoints: ["after_plan"],
        reviewerAgent: "reviewer",
        author: "tester",
        artifacts: ["plan.md"],
        validationCommands: ["bun test"],
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
  });

  test("PATCH edits draft objective and acceptanceCriteria only", async () => {
    const { app, project } = await createFixture("patch-draft");
    const created = await postGoal(app, project.slug);

    const patchRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        objective: "Updated objective.",
        acceptanceCriteria: "Updated natural-language acceptance criteria.",
      }),
      headers: { "content-type": "application/json" },
    });
    const patched = await patchRes.json() as GoalState;

    expect(patchRes.status).toBe(200);
    expect(patched).toMatchObject({
      title: null,
      objective: "Updated objective.",
      acceptanceCriteria: "Updated natural-language acceptance criteria.",
    });
    expectSimplifiedGoalShape(patched as unknown as Record<string, unknown>);
  });

  test("PATCH rejects old fields and non-draft edits", async () => {
    const { app, manager, project } = await createFixture("patch-rejects");
    const created = await postGoal(app, project.slug);

    const oldFieldRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Old manual title", doneConditions: [] }),
      headers: { "content-type": "application/json" },
    });
    await manager.setStatus(created.id, "running");
    const runningPatchRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ objective: "Too late." }),
      headers: { "content-type": "application/json" },
    });

    expect(oldFieldRes.status).toBe(400);
    expect(await oldFieldRes.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
    expect(runningPatchRes.status).toBe(409);
    expect(await runningPatchRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Goal ${created.id} is running; patch is only allowed while draft` },
    });
  });

  test("POST run starts a draft Goal and sends objective plus acceptanceCriteria only", async () => {
    const { app, bindSession, manager, project, runtime } = await createFixture("run-simplified");
    const created = await postGoal(app, project.slug);
    bindSession(providedMainSessionId, { goalId: created.id, sessionRole: "main" });
    bindSession(providedChildSessionId, { goalId: created.id, sessionRole: "build" });

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: providedMainSessionId, childSessionIds: [providedChildSessionId] }),
      headers: { "content-type": "application/json" },
    });
    const running = await runRes.json() as GoalState;

    expect(runRes.status).toBe(200);
    expect(running).toMatchObject({ status: "running", mainSessionId: providedMainSessionId, childSessionIds: [providedChildSessionId] });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).toHaveBeenCalledWith({
      slug: project.slug,
      workspaceRoot: project.workspaceRoot,
      sessionId: providedMainSessionId,
      userMessage: expect.stringContaining(`Goal ID: ${created.id}`),
    });
    expectPromptUsesNaturalLanguageOnly(lastStartedUserMessage(runtime));
    expectPromptDoesNotRequestRedundantGoalClaim(lastStartedUserMessage(runtime));
    expect(await manager.read(created.id)).toMatchObject({ status: "running", mainSessionId: providedMainSessionId });
  });

  test("POST run without body creates a main session", async () => {
    const { app, project, runtime } = await createFixture("run-creates-session");
    const created = await postGoal(app, project.slug);

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    const running = await runRes.json() as GoalState;

    expect(runRes.status).toBe(200);
    expect(running).toMatchObject({ status: "running", mainSessionId: createdMainSessionId });
    expect(runtime.createSession).toHaveBeenCalledWith(project.workspaceRoot, {
      goalId: created.id,
      sessionRole: "main",
      cwd: project.workspaceRoot,
    });
    expectPromptUsesNaturalLanguageOnly(lastStartedUserMessage(runtime));
    expectPromptDoesNotRequestRedundantGoalClaim(lastStartedUserMessage(runtime));
  });

  test("POST run rejects user-provided worktree Sessions for a non-isolated Goal", async () => {
    const { app, project, runtime } = await createFixture("run-canonical-existing-cwd");
    const foreignCwd = resolve(project.workspaceRoot, "..", "user-worktree");
    const mainGoal = await postGoal(app, project.slug);
    const childGoal = await postGoal(app, project.slug);
    (runtime.getSessionFile as ReturnType<typeof mock>).mockImplementation(async (_workspaceRoot: string, sessionId: string) => ({
      sessionId,
      title: null,
      createdAt: Date.now(),
      cwd: foreignCwd,
      messages: [],
      steps: [],
      todos: [],
      reminders: [],
      goalId: sessionId === providedMainSessionId ? mainGoal.id : childGoal.id,
      sessionRole: sessionId === providedMainSessionId ? "main" as const : "build" as const,
    }));

    const mainRes = await app.request(`/api/projects/${project.slug}/goals/${mainGoal.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: providedMainSessionId }),
      headers: { "content-type": "application/json" },
    });
    const childRes = await app.request(`/api/projects/${project.slug}/goals/${childGoal.id}/run`, {
      method: "POST",
      body: JSON.stringify({ childSessionIds: [providedChildSessionId] }),
      headers: { "content-type": "application/json" },
    });

    expect(mainRes.status).toBe(409);
    expect(await mainRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${providedMainSessionId} does not use the Goal execution directory` },
    });
    expect(childRes.status).toBe(409);
    expect(await childRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${providedChildSessionId} does not use the Goal execution directory` },
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("POST run creates a Goal worktree and gives its cwd to the canonical Session", async () => {
    const { app, manager, project, runtime } = await createFixture("run-worktree");
    await initializeGitRepo(project.workspaceRoot);
    const createRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Run this Goal in isolation.",
        acceptanceCriteria: "The main Session executes from a managed Goal worktree.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const created = await createRes.json() as GoalState;

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    const running = await runRes.json() as GoalState;

    expect(runRes.status).toBe(200);
    expect(running).toMatchObject({ useWorktree: true, worktree: { branchName: expect.stringContaining("archcode/goal/") } });
    expect(runtime.createSession).toHaveBeenCalledWith(project.workspaceRoot, {
      goalId: created.id,
      sessionRole: "main",
      cwd: running.worktree?.path,
    });
    expect((await manager.read(created.id)).worktree?.path).toBe(running.worktree?.path);
  });

  test("POST run rejects existing main and child Sessions outside the isolated Goal cwd", async () => {
    const { app, bindSession, manager, project, runtime } = await createFixture("run-worktree-existing-cwd");
    await initializeGitRepo(project.workspaceRoot);
    const createRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Enforce the selected Session cwd.",
        acceptanceCriteria: "Existing Goal Sessions cannot execute in the canonical checkout.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const created = await createRes.json() as GoalState;
    bindSession(providedMainSessionId, { goalId: created.id, sessionRole: "main", cwd: project.workspaceRoot });
    await manager.setMainSession(created.id, providedMainSessionId);

    const existingMain = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    expect(existingMain.status).toBe(409);
    expect(await existingMain.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${providedMainSessionId} does not use the Goal execution directory` },
    });

    const secondCreateRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Validate linked children too.",
        acceptanceCriteria: "Child Sessions share the Goal execution directory.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const second = await secondCreateRes.json() as GoalState;
    bindSession(providedChildSessionId, { goalId: second.id, sessionRole: "build", cwd: project.workspaceRoot });
    const child = await app.request(`/api/projects/${project.slug}/goals/${second.id}/run`, {
      method: "POST",
      body: JSON.stringify({ childSessionIds: [providedChildSessionId] }),
      headers: { "content-type": "application/json" },
    });
    expect(child.status).toBe(409);
    expect(await child.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${providedChildSessionId} does not use the Goal execution directory` },
    });
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("PATCH waits behind an isolated run reservation and cannot contradict the selected Session cwd", async () => {
    const { app, manager, project, runtime } = await createFixture("patch-run-worktree-order");
    await initializeGitRepo(project.workspaceRoot);
    const createRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Serialize draft edits with run reservation.",
        acceptanceCriteria: "Goal isolation and the selected Session cwd cannot diverge.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const created = await createRes.json() as GoalState;
    const createEntered = createDeferred();
    const releaseCreate = createDeferred();
    const createSession = runtime.createSession as ReturnType<typeof mock>;
    createSession.mockImplementation(async () => {
      createEntered.resolve();
      await releaseCreate.promise;
      return {
        sessionId: createdMainSessionId,
        title: null,
        createdAt: Date.now(),
        messages: [],
        steps: [],
        todos: [],
        reminders: [],
        sessionRole: "main",
      };
    });

    const runPromise = app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    await createEntered.promise;
    const claimed = await manager.read(created.id);
    expect(claimed).toMatchObject({ status: "draft", useWorktree: true, worktree: { path: expect.any(String) } });

    const resolveMock = runtime.contextResolver.resolve as ReturnType<typeof mock>;
    const callsBeforePatch = resolveMock.mock.calls.length;
    let patchSettled = false;
    const patchPromise = Promise.resolve(app.request(`/api/projects/${project.slug}/goals/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ useWorktree: false }),
      headers: { "content-type": "application/json" },
    })).then((response) => {
      patchSettled = true;
      return response;
    });
    await waitUntil(() => resolveMock.mock.calls.length > callsBeforePatch);
    await Bun.sleep(5);
    const patchSettledBeforeRunReleased = patchSettled;
    releaseCreate.resolve();
    const [runRes, patchRes] = await Promise.all([runPromise, patchPromise]);
    expect(patchSettledBeforeRunReleased).toBe(false);
    expect(runRes.status).toBe(200);
    expect(patchRes.status).toBe(409);
    const running = await manager.read(created.id);
    expect(running).toMatchObject({ status: "running", useWorktree: true, worktree: claimed.worktree });
    expect(createSession.mock.calls[0]?.[1]).toMatchObject({ cwd: claimed.worktree?.path });
  });

  test("route run waits for an internal Goal workspace claim across service instances", async () => {
    const { app, manager, project, runtime } = await createFixture("route-internal-workspace-claim");
    await initializeGitRepo(project.workspaceRoot);
    const createRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Share workspace claiming across route and internal entry points.",
        acceptanceCriteria: "The route reserves its Session only after the internal worktree claim is durable.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const created = await createRes.json() as GoalState;
    const realWorktrees = new WorktreeService({ canonicalRoot: project.workspaceRoot });
    const worktreeCreated = createValueDeferred<WorktreeCreateResult>();
    const releaseCreate = createDeferred();
    const internalWorktrees = {
      findManaged: (input: Parameters<WorktreeService["findManaged"]>[0]) => realWorktrees.findManaged(input),
      validateManagedClaim: (input: Parameters<WorktreeService["validateManagedClaim"]>[0]) => realWorktrees.validateManagedClaim(input),
      remove: (input: Parameters<WorktreeService["remove"]>[0]) => realWorktrees.remove(input),
      create: async (input: Parameters<WorktreeService["create"]>[0]) => {
        const result = await realWorktrees.create(input);
        worktreeCreated.resolve(result);
        await releaseCreate.promise;
        return result;
      },
    };
    const internalPrepare = new GoalWorkspaceService({
      canonicalRoot: project.workspaceRoot,
      goalStateManager: manager,
      worktreeService: internalWorktrees,
    }).prepare(created.id);
    await worktreeCreated.promise;

    let routeSettled = false;
    const runPromise = Promise.resolve(app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" }))
      .then((response) => {
        routeSettled = true;
        return response;
      });
    await Bun.sleep(300);
    const routeSettledBeforeInternalClaim = routeSettled;
    const sessionsBeforeInternalClaim = (runtime.createSession as ReturnType<typeof mock>).mock.calls.length;
    releaseCreate.resolve();

    const [prepared, runRes] = await Promise.all([internalPrepare, runPromise]);
    const running = await runRes.json() as GoalState;
    expect(routeSettledBeforeInternalClaim).toBe(false);
    expect(sessionsBeforeInternalClaim).toBe(0);
    expect(runRes.status).toBe(200);
    expect(running.worktree).toEqual(prepared.goal.worktree);
    expect(runtime.createSession).toHaveBeenCalledWith(project.workspaceRoot, {
      goalId: created.id,
      sessionRole: "main",
      cwd: prepared.cwd,
    });
  });

  test("route and internal runner share one execution claim through Session reservation and state start", async () => {
    const { app, manager, project, runtime } = await createFixture("route-internal-execution-claim");
    await initializeGitRepo(project.workspaceRoot);
    const createRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Claim one main Session across entry points.",
        acceptanceCriteria: "Concurrent Route and GoalRunner starts cannot leave an orphan Session.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const created = await createRes.json() as GoalState;
    const prepared = await new GoalWorkspaceService({
      canonicalRoot: project.workspaceRoot,
      goalStateManager: manager,
    }).prepare(created.id);
    const releaseSessionCreation = createDeferred();
    const internalCreateEntered = createDeferred();
    const createdSessionIds: string[] = [];
    const internalRunner = new GoalRunner({
      goalStateManager: manager as never,
      workspaceRoot: project.workspaceRoot,
      createSession: async (options) => {
        expect(options?.cwd).toBe(prepared.cwd);
        createdSessionIds.push(providedMainSessionId);
        internalCreateEntered.resolve();
        await releaseSessionCreation.promise;
        return providedMainSessionId;
      },
      getSessionCwd: async (sessionId) => sessionId === providedMainSessionId ? prepared.cwd : undefined,
    });
    (runtime.getSessionFile as ReturnType<typeof mock>).mockImplementation(async (_workspaceRoot: string, sessionId: string) => ({
      sessionId,
      title: null,
      createdAt: Date.now(),
      cwd: sessionId === providedMainSessionId ? prepared.cwd : project.workspaceRoot,
      messages: [],
      steps: [],
      todos: [],
      reminders: [],
      goalId: created.id,
      sessionRole: "main" as const,
    }));
    (runtime.createSession as ReturnType<typeof mock>).mockImplementation(async (_workspaceRoot: string, options?: { cwd?: string }) => {
      createdSessionIds.push(createdMainSessionId);
      await releaseSessionCreation.promise;
      return {
        sessionId: createdMainSessionId,
        title: null,
        createdAt: Date.now(),
        cwd: options?.cwd,
        messages: [],
        steps: [],
        todos: [],
        reminders: [],
        goalId: created.id,
        sessionRole: "main",
      };
    });

    const internalStart = internalRunner.start(created.id);
    await internalCreateEntered.promise;
    const routeStart = Promise.resolve(app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" }));
    await Bun.sleep(300);
    const routeSessionCreationsBeforeInternalStart = (runtime.createSession as ReturnType<typeof mock>).mock.calls.length;
    releaseSessionCreation.resolve();

    const [internalResult, routeResult] = await Promise.allSettled([internalStart, routeStart]);
    expect(internalResult.status).toBe("fulfilled");
    expect(routeResult.status).toBe("fulfilled");
    if (routeResult.status !== "fulfilled") throw routeResult.reason;
    expect(routeResult.value.status).toBe(200);
    expect(routeSessionCreationsBeforeInternalStart).toBe(0);
    expect(createdSessionIds).toEqual([providedMainSessionId]);
    expect(await manager.read(created.id)).toMatchObject({
      status: "running",
      mainSessionId: providedMainSessionId,
      worktree: prepared.goal.worktree,
    });
  });

  test("POST retry reuses one Goal worktree and terminal actions preserve it", async () => {
    const { app, manager, project, runtime } = await createFixture("retry-worktree-reuse");
    await initializeGitRepo(project.workspaceRoot);
    const createRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Retry in one isolated checkout.",
        acceptanceCriteria: "Run and retry use the same persisted worktree.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const created = await createRes.json() as GoalState;
    const first = await (await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" })).json() as GoalState;
    await manager.setReview(created.id);

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, { method: "POST" });
    const retried = await retryRes.json() as GoalState;
    expect(retryRes.status).toBe(200);
    expect(retried.worktree).toEqual(first.worktree);
    const createCalls = (runtime.createSession as ReturnType<typeof mock>).mock.calls;
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]?.[1]).toMatchObject({ cwd: first.worktree?.path });
    expect(createCalls[1]?.[1]).toMatchObject({ cwd: first.worktree?.path });

    const cancelRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    expect(await Bun.file(resolve(first.worktree!.path, "README.md")).exists()).toBe(true);
    expect(await runGit(project.workspaceRoot, ["branch", "--list", first.worktree!.branchName])).toContain(first.worktree!.branchName);
  });

  test("PATCH waits behind retry reservation and leaves retry Session cwd consistent", async () => {
    const { app, manager, project, runtime } = await createFixture("patch-retry-worktree-order");
    await initializeGitRepo(project.workspaceRoot);
    const createRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Serialize retry with draft patch attempts.",
        acceptanceCriteria: "Retry keeps the persisted Goal worktree and Session cwd.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const created = await createRes.json() as GoalState;
    const firstRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    expect(firstRes.status).toBe(200);
    const first = await firstRes.json() as GoalState;
    await manager.setReview(created.id);

    const createEntered = createDeferred();
    const releaseCreate = createDeferred();
    const createSession = runtime.createSession as ReturnType<typeof mock>;
    createSession.mockImplementation(async () => {
      createEntered.resolve();
      await releaseCreate.promise;
      return {
        sessionId: retrySessionId,
        title: null,
        createdAt: Date.now(),
        messages: [],
        steps: [],
        todos: [],
        reminders: [],
        sessionRole: "main",
      };
    });

    const retryPromise = app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, { method: "POST" });
    await createEntered.promise;
    const resolveMock = runtime.contextResolver.resolve as ReturnType<typeof mock>;
    const callsBeforePatch = resolveMock.mock.calls.length;
    let patchSettled = false;
    const patchPromise = Promise.resolve(app.request(`/api/projects/${project.slug}/goals/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ useWorktree: false }),
      headers: { "content-type": "application/json" },
    })).then((response) => {
      patchSettled = true;
      return response;
    });
    await waitUntil(() => resolveMock.mock.calls.length > callsBeforePatch);
    await Bun.sleep(5);
    const patchSettledBeforeRetryReleased = patchSettled;
    releaseCreate.resolve();
    const [retryRes, patchRes] = await Promise.all([retryPromise, patchPromise]);
    expect(patchSettledBeforeRetryReleased).toBe(false);
    expect(retryRes.status).toBe(200);
    expect(patchRes.status).toBe(409);
    expect(await manager.read(created.id)).toMatchObject({ status: "running", useWorktree: true, worktree: first.worktree });
    expect(createSession.mock.calls[1]?.[1]).toMatchObject({ cwd: first.worktree?.path });
  });

  test("POST retry rejects an active reserved Session before isolated workspace revalidation", async () => {
    const { app, bindSession, manager, project, runtime } = await createFixture("retry-final-selected-cwd");
    await initializeGitRepo(project.workspaceRoot);
    const createRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Validate the final retry Session.",
        acceptanceCriteria: "An active canonical Session cannot resume an isolated Goal.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const created = await createRes.json() as GoalState;
    const firstRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    expect(firstRes.status).toBe(200);
    await manager.setReview(created.id);
    await manager.setMainSession(created.id, activeRetrySessionId);
    bindSession(activeRetrySessionId, { goalId: created.id, sessionRole: "main", cwd: project.workspaceRoot });
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation(
      (_workspaceRoot: string, sessionId: string) => sessionId === activeRetrySessionId,
    );

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, { method: "POST" });

    expect(retryRes.status).toBe(409);
    expect(await retryRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Goal ${created.id} cannot transition while Session ${activeRetrySessionId} is active` },
    });
    expect(runtime.startSessionExecution).toHaveBeenCalledTimes(1);
  });

  test("POST retry treats only the same active running main Session as idempotent", async () => {
    const { app, bindSession, manager, project, runtime } = await createFixture("retry-running-idempotency");
    const inactiveGoal = await postGoal(app, project.slug);
    bindSession(activeRetrySessionId, { goalId: inactiveGoal.id, sessionRole: "main" });
    await manager.setMainSession(inactiveGoal.id, activeRetrySessionId);
    await manager.setStatus(inactiveGoal.id, "running");

    const inactiveRes = await app.request(`/api/projects/${project.slug}/goals/${inactiveGoal.id}/retry`, { method: "POST" });
    expect(inactiveRes.status).toBe(409);
    expect(await inactiveRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Running Goal ${inactiveGoal.id} can retry only through its active main Session` },
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();

    const activeGoal = await postGoal(app, project.slug);
    bindSession(activeRetrySessionId, { goalId: activeGoal.id, sessionRole: "main" });
    await manager.setMainSession(activeGoal.id, activeRetrySessionId);
    await manager.setStatus(activeGoal.id, "running");
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation(
      (_workspaceRoot: string, sessionId: string) => sessionId === activeRetrySessionId,
    );

    const activeRes = await app.request(`/api/projects/${project.slug}/goals/${activeGoal.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: activeRetrySessionId }),
      headers: { "content-type": "application/json" },
    });
    expect(activeRes.status).toBe(200);
    expect(await activeRes.json()).toMatchObject({ id: activeGoal.id, status: "running", mainSessionId: activeRetrySessionId });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("POST run rejects terminal and non-runnable statuses", async () => {
    const { app, manager, project, runtime } = await createFixture("run-invalid-status");
    const created = await postGoal(app, project.slug);
    await manager.setStatus(created.id, "done");

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });

    expect(runRes.status).toBe(409);
    expect(await runRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Invalid goal state for ${created.id}` },
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("HTTP run, retry, and cancel reject Loop-owned Goals without a trusted Loop execution scope", async () => {
    const { app, manager, project, runtime } = await createFixture("reject-loop-owned-goal");
    const loopId = "11111111-1111-4111-8111-111111111111";
    const goal = await manager.create({
      projectId: project.slug,
      objective: "Run only through the owning Loop.",
      acceptanceCriteria: "HTTP Goal routes cannot infer a Loop execution scope.",
      loopId,
    });

    const runRes = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/run`, { method: "POST" });
    const cancelRes = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/cancel`, { method: "POST" });
    await manager.setStatus(goal.id, "failed");
    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/retry`, { method: "POST" });
    const expected = {
      error: {
        code: "BAD_REQUEST",
        message: `Goal ${goal.id} is owned by Loop ${loopId} and must be resumed by its owning Loop`,
      },
    };

    expect(runRes.status).toBe(409);
    expect(await runRes.json()).toEqual(expected);
    expect(retryRes.status).toBe(409);
    expect(await retryRes.json()).toEqual(expected);
    expect(cancelRes.status).toBe(409);
    expect(await cancelRes.json()).toEqual(expected);
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("POST run and retry validate provided session IDs before reservation", async () => {
    const { app, bindSession, manager, project, runtime } = await createFixture("session-validation");
    const created = await postGoal(app, project.slug);
    bindSession(nonMainSessionId, { goalId: created.id, sessionRole: "explore" });

    const invalidUuidRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: "not-a-session-uuid" }),
      headers: { "content-type": "application/json" },
    });
    const missingRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: missingSessionId }),
      headers: { "content-type": "application/json" },
    });
    const otherGoalRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, {
      method: "POST",
      body: JSON.stringify({ childSessionIds: [otherGoalSessionId] }),
      headers: { "content-type": "application/json" },
    });
    await manager.setReview(created.id);
    const nonMainRetryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: nonMainSessionId }),
      headers: { "content-type": "application/json" },
    });

    expect(invalidUuidRes.status).toBe(400);
    expect(await invalidUuidRes.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
    expect(missingRes.status).toBe(400);
    expect(await missingRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "mainSessionId must reference an existing session in this project" },
    });
    expect(otherGoalRes.status).toBe(409);
    expect(await otherGoalRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${otherGoalSessionId} belongs to a different goal` },
    });
    expect(nonMainRetryRes.status).toBe(409);
    expect(await nonMainRetryRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${nonMainSessionId} is not a main goal session` },
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("POST run rejects unbound Goal Sessions and an untyped main Session before claiming resources", async () => {
    const { app, bindSession, manager, project, runtime } = await createFixture("session-goal-identity");
    await initializeGitRepo(project.workspaceRoot);
    const createRes = await app.request(`/api/projects/${project.slug}/goals`, {
      method: "POST",
      body: JSON.stringify({
        objective: "Require exact Session ownership.",
        acceptanceCriteria: "Unbound Sessions cannot claim this isolated Goal.",
        useWorktree: true,
      }),
      headers: { "content-type": "application/json" },
    });
    const goal = await createRes.json() as GoalState;

    const unboundMain = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: providedMainSessionId }),
      headers: { "content-type": "application/json" },
    });
    const unboundChild = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/run`, {
      method: "POST",
      body: JSON.stringify({ childSessionIds: [providedChildSessionId] }),
      headers: { "content-type": "application/json" },
    });
    bindSession(providedMainSessionId, { goalId: goal.id });
    const untypedMain = await app.request(`/api/projects/${project.slug}/goals/${goal.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: providedMainSessionId }),
      headers: { "content-type": "application/json" },
    });

    expect(unboundMain.status).toBe(409);
    expect(await unboundMain.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${providedMainSessionId} is not assigned to Goal ${goal.id}` },
    });
    expect(unboundChild.status).toBe(409);
    expect(await unboundChild.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${providedChildSessionId} is not assigned to Goal ${goal.id}` },
    });
    expect(untypedMain.status).toBe(409);
    expect(await untypedMain.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${providedMainSessionId} is not a main goal session` },
    });
    expect(await manager.read(goal.id)).toMatchObject({ status: "draft", childSessionIds: [] });
    expect((await manager.read(goal.id)).mainSessionId).toBeUndefined();
    expect((await manager.read(goal.id)).worktree).toBeUndefined();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("POST run and retry reject every active provided or reserved Session before Goal mutation", async () => {
    const { app, bindSession, manager, project, runtime } = await createFixture("active-session-transition-claim");
    const activeSessionIds = new Set<string>([
      providedMainSessionId,
      providedChildSessionId,
      retrySessionId,
      activeRetrySessionId,
      otherRetrySessionId,
    ]);
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation(
      (_workspaceRoot: string, sessionId: string) => activeSessionIds.has(sessionId),
    );

    const draftMain = await postGoal(app, project.slug);
    bindSession(providedMainSessionId, { goalId: draftMain.id, sessionRole: "main" });
    const draftMainRes = await app.request(`/api/projects/${project.slug}/goals/${draftMain.id}/run`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: providedMainSessionId }),
      headers: { "content-type": "application/json" },
    });

    const draftChild = await postGoal(app, project.slug);
    bindSession(providedChildSessionId, { goalId: draftChild.id, sessionRole: "build" });
    const draftChildRes = await app.request(`/api/projects/${project.slug}/goals/${draftChild.id}/run`, {
      method: "POST",
      body: JSON.stringify({ childSessionIds: [providedChildSessionId] }),
      headers: { "content-type": "application/json" },
    });

    const notDone = await postGoal(app, project.slug);
    await manager.setReview(notDone.id);
    bindSession(retrySessionId, { goalId: notDone.id, sessionRole: "main" });
    const notDoneRes = await app.request(`/api/projects/${project.slug}/goals/${notDone.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: retrySessionId }),
      headers: { "content-type": "application/json" },
    });

    const failed = await postGoal(app, project.slug);
    await manager.setStatus(failed.id, "failed");
    bindSession(activeRetrySessionId, { goalId: failed.id, sessionRole: "main" });
    await manager.setMainSession(failed.id, activeRetrySessionId);
    const failedRes = await app.request(`/api/projects/${project.slug}/goals/${failed.id}/retry`, { method: "POST" });

    for (const [response, goal, activeSessionId] of [
      [draftMainRes, draftMain, providedMainSessionId],
      [draftChildRes, draftChild, providedChildSessionId],
      [notDoneRes, notDone, retrySessionId],
      [failedRes, failed, activeRetrySessionId],
    ] as const) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "BAD_REQUEST",
          message: `Goal ${goal.id} cannot transition while Session ${activeSessionId} is active`,
        },
      });
    }

    expect(await manager.read(draftMain.id)).toMatchObject({ status: "draft", childSessionIds: [] });
    expect((await manager.read(draftMain.id)).mainSessionId).toBeUndefined();
    expect(await manager.read(draftChild.id)).toMatchObject({ status: "draft", childSessionIds: [] });
    expect(await manager.read(notDone.id)).toMatchObject({ status: "not_done", attempt: 1 });
    expect((await manager.read(notDone.id)).mainSessionId).toBeUndefined();
    expect(await manager.read(failed.id)).toMatchObject({ status: "failed", attempt: 1, mainSessionId: activeRetrySessionId });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("POST retry restarts not_done Goal and sends objective plus acceptanceCriteria only", async () => {
    const { app, bindSession, manager, project, runtime } = await createFixture("retry-simplified");
    const created = await postGoal(app, project.slug);
    await manager.setReview(created.id);
    bindSession(retrySessionId, { goalId: created.id, sessionRole: "main" });

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: retrySessionId }),
      headers: { "content-type": "application/json" },
    });
    const retried = await retryRes.json() as GoalState;

    expect(retryRes.status).toBe(200);
    expect(retried).toMatchObject({ status: "running", attempt: 2, mainSessionId: retrySessionId });
    expect(retried.review).toBeUndefined();
    expect(runtime.startSessionExecution).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: retrySessionId,
      userMessage: expect.stringContaining("Runtime has already started and claimed this retry"),
    }));
    expectPromptUsesNaturalLanguageOnly(lastStartedUserMessage(runtime));
    expectPromptDoesNotRequestRedundantGoalClaim(lastStartedUserMessage(runtime));
  });

  test("POST retry rejects a user-provided worktree Session for a non-isolated Goal", async () => {
    const { app, manager, project, runtime } = await createFixture("retry-canonical-existing-cwd");
    const created = await postGoal(app, project.slug);
    await manager.setReview(created.id);
    const foreignCwd = resolve(project.workspaceRoot, "..", "retry-user-worktree");
    (runtime.getSessionFile as ReturnType<typeof mock>).mockImplementation(async (_workspaceRoot: string, sessionId: string) => ({
      sessionId,
      title: null,
      createdAt: Date.now(),
      cwd: foreignCwd,
      messages: [],
      steps: [],
      todos: [],
      reminders: [],
      goalId: created.id,
      sessionRole: "main" as const,
    }));

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: retrySessionId }),
      headers: { "content-type": "application/json" },
    });

    expect(retryRes.status).toBe(409);
    expect(await retryRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Session ${retrySessionId} does not use the Goal execution directory` },
    });
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("POST retry rejects active reserved session mismatch", async () => {
    const { app, bindSession, manager, project, runtime } = await createFixture("retry-session-mismatch");
    const created = await postGoal(app, project.slug);
    await manager.setReview(created.id);
    bindSession(activeRetrySessionId, { goalId: created.id, sessionRole: "main" });
    bindSession(otherRetrySessionId, { goalId: created.id, sessionRole: "main" });
    await manager.setMainSession(created.id, activeRetrySessionId);
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation((_workspaceRoot: string, sessionId: string) => sessionId === activeRetrySessionId);

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: otherRetrySessionId }),
      headers: { "content-type": "application/json" },
    });

    expect(retryRes.status).toBe(409);
    expect(await retryRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Goal ${created.id} cannot transition while Session ${activeRetrySessionId} is active` },
    });
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("POST cancel moves an active Goal to cancelled", async () => {
    const { app, manager, project } = await createFixture("cancel-goal");
    const created = await postGoal(app, project.slug);
    await manager.setStatus(created.id, "running");

    const cancelRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/cancel`, { method: "POST" });
    const cancelled = await cancelRes.json() as GoalState;

    expect(cancelRes.status).toBe(200);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).toBeString();
  });

  test("POST cancel aborts the main Session family and cancels Goal/Session HITL owners before committing", async () => {
    const { app, manager, project, runtime } = await createFixture("cancel-active-family");
    const created = await postGoal(app, project.slug);
    await manager.setStatus(created.id, "running");
    await manager.setMainSession(created.id, providedMainSessionId);
    await manager.addChildSession(created.id, providedChildSessionId);
    let running = true;
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation(() => running);
    (runtime.abortSessionExecutionAndWait as ReturnType<typeof mock>).mockImplementation(async () => {
      running = false;
    });

    const cancelRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/cancel`, { method: "POST" });

    expect(cancelRes.status).toBe(200);
    expect(runtime.abortSessionExecutionAndWait).toHaveBeenCalledWith(project.workspaceRoot, providedMainSessionId);
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    expect(context.hitl.cancelOwner).toHaveBeenCalledWith({
      projectSlug: project.slug,
      ownerType: "session",
      ownerId: providedMainSessionId,
    }, "goal_cancelled");
    expect(context.hitl.cancelOwner).toHaveBeenCalledWith({
      projectSlug: project.slug,
      ownerType: "session",
      ownerId: providedChildSessionId,
    }, "goal_cancelled");
    expect(context.hitl.cancelOwner).toHaveBeenCalledWith({
      projectSlug: project.slug,
      ownerType: "goal",
      ownerId: created.id,
    }, "goal_cancelled");
  });

  test("POST cancel does not commit cancelled while the Session family is still active", async () => {
    const { app, manager, project, runtime } = await createFixture("cancel-stuck-family");
    const created = await postGoal(app, project.slug);
    await manager.setStatus(created.id, "running");
    await manager.setMainSession(created.id, providedMainSessionId);
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockReturnValue(true);

    const cancelRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/cancel`, { method: "POST" });

    expect(cancelRes.status).toBe(409);
    expect((await manager.read(created.id)).status).toBe("running");
  });

  test("POST cancel cleans a blocked main Session HITL owner even without an active execution", async () => {
    const { app, manager, project, runtime } = await createFixture("cancel-blocked-hitl");
    const created = await postGoal(app, project.slug);
    await manager.setStatus(created.id, "blocked");
    await manager.setMainSession(created.id, providedMainSessionId);

    const cancelRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/cancel`, { method: "POST" });

    expect(cancelRes.status).toBe(200);
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    expect(context.hitl.cancelOwner).toHaveBeenCalledWith({
      projectSlug: project.slug,
      ownerType: "session",
      ownerId: providedMainSessionId,
    }, "goal_cancelled");
  });

  test("Goal claim lock makes concurrent run lose to an in-flight cancellation", async () => {
    const { app, manager, project, runtime } = await createFixture("cancel-run-race");
    const created = await postGoal(app, project.slug);
    await manager.setStatus(created.id, "running");
    await manager.setMainSession(created.id, providedMainSessionId);
    let releaseAbort!: () => void;
    const abortReleased = new Promise<void>((resolve) => { releaseAbort = resolve; });
    let running = true;
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation(() => running);
    (runtime.abortSessionExecutionAndWait as ReturnType<typeof mock>).mockImplementation(async () => {
      await abortReleased;
      running = false;
    });

    const cancellation = app.request(`/api/projects/${project.slug}/goals/${created.id}/cancel`, { method: "POST" });
    while ((runtime.abortSessionExecutionAndWait as ReturnType<typeof mock>).mock.calls.length === 0) await Bun.sleep(1);
    const concurrentRun = app.request(`/api/projects/${project.slug}/goals/${created.id}/run`, { method: "POST" });
    releaseAbort();

    const [cancelRes, runRes] = await Promise.all([cancellation, concurrentRun]);
    expect(cancelRes.status).toBe(200);
    expect(runRes.status).toBe(409);
    expect(runtime.startSessionExecution).not.toHaveBeenCalled();
  });

  test("POST cancel maps GoalTransitionError to the existing conflict shape", async () => {
    const { app, manager, project } = await createFixture("cancel-transition-error");
    const created = await postGoal(app, project.slug);
    await manager.setStatus(created.id, "done");

    const cancelRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/cancel`, { method: "POST" });

    expect(cancelRes.status).toBe(409);
    expect(await cancelRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Invalid goal transition done -> cancelled for ${created.id}` },
    });
  });

  test("GET list and read expose simplified GoalState only", async () => {
    const { app, project } = await createFixture("list-read");
    const created = await postGoal(app, project.slug);

    const listRes = await app.request(`/api/projects/${project.slug}/goals?status=draft`);
    const listBody = await listRes.json() as { goals: GoalState[] };
    const readRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}`);
    const readGoal = await readRes.json() as GoalState;

    expect(listRes.status).toBe(200);
    expect(listBody.goals.map((goal) => goal.id)).toEqual([created.id]);
    expect(readRes.status).toBe(200);
    expect(readGoal.id).toBe(created.id);
    expectSimplifiedGoalShape(readGoal as unknown as Record<string, unknown>);
  });

  test("GET read maps reviewer lifecycle errors to the existing conflict shape", async () => {
    const { app, manager, project } = await createFixture("reviewer-lifecycle-errors");
    const created = await postGoal(app, project.slug);

    manager.failNextRead(new FakeGoalReviewFinalizationError(created.id, "DONE review requires at least one evidence ref"));
    const finalizationRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}`);
    manager.failNextRead(new FakeGoalReviewerAuthorizationError(created.id, "Review finalization requires reviewer agent, got build"));
    const authorizationRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}`);

    expect(finalizationRes.status).toBe(409);
    expect(await finalizationRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "DONE review requires at least one evidence ref" },
    });
    expect(authorizationRes.status).toBe(409);
    expect(await authorizationRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "Review finalization requires reviewer agent, got build" },
    });
  });

  test("deleted artifact lock and escalate routes are not registered", async () => {
    const { app, project } = await createFixture("deleted-routes");
    const created = await postGoal(app, project.slug);

    const artifactList = await app.request(`/api/projects/${project.slug}/goals/${created.id}/artifacts`);
    const artifactRead = await app.request(`/api/projects/${project.slug}/goals/${created.id}/artifacts/plan.md`);
    const lock = await app.request(`/api/projects/${project.slug}/goals/${created.id}/lock`, { method: "POST" });
    const escalate = await app.request(`/api/projects/${project.slug}/goals/${created.id}/escalate`, { method: "POST" });

    expect(artifactList.status).toBe(404);
    expect(artifactRead.status).toBe(404);
    expect(lock.status).toBe(404);
    expect(escalate.status).toBe(404);
  });

  test("invalid goal id path returns 400 and missing goal returns 404", async () => {
    const { app, project } = await createFixture("missing-invalid");
    const missingGoalId = crypto.randomUUID();

    const invalidRes = await app.request(`/api/projects/${project.slug}/goals/not-a-uuid`);
    const missingRes = await app.request(`/api/projects/${project.slug}/goals/${missingGoalId}`);

    expect(invalidRes.status).toBe(400);
    expect(await invalidRes.json()).toEqual({ error: { code: "BAD_REQUEST", message: "goalId must be a UUID" } });
    expect(missingRes.status).toBe(404);
    expect(await missingRes.json()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: `Goal not found: ${missingGoalId}` },
    });
  });
});

async function initializeGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ["init", "--initial-branch=main"]);
  await runGit(cwd, ["config", "user.email", "goal-route@example.com"]);
  await runGit(cwd, ["config", "user.name", "Goal Route"]);
  await writeFile(resolve(cwd, "README.md"), "# Goal route\n");
  await runGit(cwd, ["add", "README.md"]);
  await runGit(cwd, ["commit", "-m", "initial commit"]);
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

function createDeferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createValueDeferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for concurrent Goal request to reach the reservation boundary");
}
