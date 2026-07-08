import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import type { GoalState, GoalStatus } from "@archcode/protocol";
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

class FakeGoalNotFoundError extends Error {
  constructor(goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = "GoalNotFoundError";
  }
}

class FakeGoalStateManager {
  readonly #goals = new Map<string, GoalState>();
  readonly #now = new Date("2026-07-08T00:00:00.000Z").toISOString();

  async listGoals(projectId?: string): Promise<GoalState[]> {
    return [...this.#goals.values()].filter((goal) => projectId === undefined || goal.projectId === projectId);
  }

  async create(input: { readonly projectId: string; readonly title: string; readonly objective: string; readonly acceptanceCriteria: string }): Promise<GoalState> {
    const goal: GoalState = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: input.title,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      status: "draft",
      attempt: 0,
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
    const goal = this.#goals.get(goalId);
    if (goal === undefined) throw new FakeGoalNotFoundError(goalId);
    return goal;
  }

  async patchDraft(goalId: string, updates: Partial<Pick<GoalState, "title" | "objective" | "acceptanceCriteria">>): Promise<GoalState> {
    const goal = await this.read(goalId);
    if (goal.status !== "draft") {
      throw new FakeGoalStateError(`Goal ${goalId} is ${goal.status}; patch is only allowed while draft`);
    }
    return this.#update(goalId, { ...updates, updatedAt: this.#now });
  }

  async start(goalId: string, input: { readonly mainSessionId?: string } = {}): Promise<GoalState> {
    const goal = await this.read(goalId);
    if (goal.status !== "draft" && goal.status !== "running") {
      throw new FakeGoalStateError(`Invalid transition ${goal.status} → running`);
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
      throw new FakeGoalStateError(`Invalid transition ${goal.status} → running`);
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
      throw new FakeGoalStateError(`Cannot cancel terminal goal ${goalId}`);
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

  #update(goalId: string, updates: Partial<GoalState>): GoalState {
    const goal = this.#goals.get(goalId);
    if (goal === undefined) throw new FakeGoalNotFoundError(goalId);
    const updated = { ...goal, ...updates };
    this.#goals.set(goalId, updated);
    return updated;
  }
}

function createRuntime(project: ProjectInfo, manager: FakeGoalStateManager): RouteRuntime {
  const runtime = {
    projectRegistry: {
      get: mock(async (slug: string) => slug === project.slug ? project : undefined),
    },
    contextResolver: {
      resolve: mock(async () => ({ goalState: manager })),
    },
    createSession: mock(async () => ({ sessionId: createdMainSessionId, title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [], goalId: undefined, sessionRole: "main" })),
    getSessionFile: mock(async (_workspaceRoot: string, sessionId: string) => {
      if (sessionId === missingSessionId) throw new Error("Session not found");
      return {
        sessionId,
        title: null,
        createdAt: Date.now(),
        messages: [],
        steps: [],
        todos: [],
        reminders: [],
        ...(sessionId === otherGoalSessionId ? { goalId: otherGoalId } : {}),
        ...(sessionId === nonMainSessionId ? { sessionRole: "explore" as const } : { sessionRole: "main" as const }),
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
    isSessionExecutionRunning: mock(() => false),
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
  const runtime = createRuntime(project, manager);
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/projects", createGoalsRoutes(runtime));
  return { app, manager, project, runtime };
}

async function postGoal(app: Hono, slug: string, title = "Simplify Goal API"): Promise<GoalState> {
  const res = await app.request(`/api/projects/${slug}/goals`, {
    method: "POST",
    body: JSON.stringify({
      title,
      objective: "Expose a natural-language Goal contract from the server.",
      acceptanceCriteria: "The API accepts title, objective, and acceptance criteria only.",
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
  expect(goal.title).toBeString();
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
  expect(message).toContain("The API accepts title, objective, and acceptance criteria only.");
  expect(message).not.toContain("DoneCondition");
  expect(message).not.toContain("Done Conditions");
  expect(message).not.toContain("doneConditions");
  expect(message).not.toContain("validation command");
  expect(message).not.toContain("command_succeeds");
  expect(message).not.toContain("typecheck_pass");
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
    const { app, project } = await createFixture("create-simplified");

    const goal = await postGoal(app, project.slug);

    expect(goal).toMatchObject({
      projectId: project.slug,
      title: "Simplify Goal API",
      objective: "Expose a natural-language Goal contract from the server.",
      acceptanceCriteria: "The API accepts title, objective, and acceptance criteria only.",
      status: "draft",
      attempt: 0,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
    });
    expectSimplifiedGoalShape(goal as unknown as Record<string, unknown>);
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

  test("PATCH edits draft title objective and acceptanceCriteria only", async () => {
    const { app, project } = await createFixture("patch-draft");
    const created = await postGoal(app, project.slug);

    const patchRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: "Updated title",
        objective: "Updated objective.",
        acceptanceCriteria: "Updated natural-language acceptance criteria.",
      }),
      headers: { "content-type": "application/json" },
    });
    const patched = await patchRes.json() as GoalState;

    expect(patchRes.status).toBe(200);
    expect(patched).toMatchObject({
      title: "Updated title",
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
      body: JSON.stringify({ doneConditions: [] }),
      headers: { "content-type": "application/json" },
    });
    await manager.setStatus(created.id, "running");
    const runningPatchRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Too late" }),
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
    const { app, manager, project, runtime } = await createFixture("run-simplified");
    const created = await postGoal(app, project.slug, "Run simplified Goal");

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
      title: created.title,
    });
    expectPromptUsesNaturalLanguageOnly(lastStartedUserMessage(runtime));
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

  test("POST run and retry validate provided session IDs before reservation", async () => {
    const { app, manager, project, runtime } = await createFixture("session-validation");
    const created = await postGoal(app, project.slug);

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

  test("POST retry restarts not_done Goal and sends objective plus acceptanceCriteria only", async () => {
    const { app, manager, project, runtime } = await createFixture("retry-simplified");
    const created = await postGoal(app, project.slug, "Retry simplified Goal");
    await manager.setReview(created.id);

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: retrySessionId }),
      headers: { "content-type": "application/json" },
    });
    const retried = await retryRes.json() as GoalState;

    expect(retryRes.status).toBe(200);
    expect(retried).toMatchObject({ status: "running", attempt: 1, mainSessionId: retrySessionId });
    expect(retried.review).toBeUndefined();
    expect(runtime.startSessionExecution).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: retrySessionId,
      userMessage: expect.stringContaining("goal_manage with action:\"retry\""),
    }));
    expectPromptUsesNaturalLanguageOnly(lastStartedUserMessage(runtime));
  });

  test("POST retry rejects active reserved session mismatch", async () => {
    const { app, manager, project, runtime } = await createFixture("retry-session-mismatch");
    const created = await postGoal(app, project.slug);
    await manager.setReview(created.id);
    await manager.setMainSession(created.id, activeRetrySessionId);
    (runtime.isSessionExecutionRunning as ReturnType<typeof mock>).mockImplementation((_workspaceRoot: string, sessionId: string) => sessionId === activeRetrySessionId);

    const retryRes = await app.request(`/api/projects/${project.slug}/goals/${created.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ mainSessionId: otherRetrySessionId }),
      headers: { "content-type": "application/json" },
    });

    expect(retryRes.status).toBe(409);
    expect(await retryRes.json()).toEqual({
      error: { code: "BAD_REQUEST", message: `Goal ${created.id} is already reserved for session ${activeRetrySessionId}` },
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
