import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { GoalState } from "@archcode/protocol";
import { ModelRuntime, type ActiveSessionExecution, type AgentRuntime, type ProjectContext, type ProjectInfo } from "@archcode/agent-core";

import { errorHandler } from "../error-handler";
import { createGoalsRoutes } from "./goals";

const roots: string[] = [];
let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "archcode-goals-route-"));
  roots.push(workspaceRoot);
});

afterAll(async () => {
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("Goal routes", () => {
  test("lists and reads committed Goals with provenance", async () => {
    const first = makeGoal();
    const second = makeGoal({ id: crypto.randomUUID(), status: "done", title: "Finished" });
    const fixture = createFixture([first, second]);

    const list = await fixture.app.request(`/api/projects/${fixture.project.slug}/goals?status=running`);
    const detail = await fixture.app.request(`/api/projects/${fixture.project.slug}/goals/${first.id}`);

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ goals: [first] });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: first.id,
      status: "running",
      createdFromSessionId: first.createdFromSessionId,
      mainSessionId: first.mainSessionId,
    });
  });

  test("rejects removed draft status and exposes no create, patch, or initial run route", async () => {
    const fixture = createFixture([makeGoal()]);
    const base = `/api/projects/${fixture.project.slug}/goals`;

    const removed = await Promise.all([
      fixture.app.request(base, { method: "POST", body: JSON.stringify({ objective: "x", acceptanceCriteria: "y" }) }),
      fixture.app.request(`${base}/${fixture.goals[0]!.id}`, { method: "PATCH", body: JSON.stringify({ objective: "x" }) }),
      fixture.app.request(`${base}/${fixture.goals[0]!.id}/run`, { method: "POST" }),
    ]);
    const draftFilter = await fixture.app.request(`${base}?status=draft`);

    expect(removed.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(draftFilter.status).toBe(400);
  });

  test("retries through GoalLifecycleService and the existing Goal Lead Session", async () => {
    const goal = makeGoal({ status: "not_done" });
    const fixture = createFixture([goal]);

    const response = await fixture.app.request(
      `/api/projects/${fixture.project.slug}/goals/${goal.id}/retry`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(fixture.retry).toHaveBeenCalledWith(goal.id);
    expect(fixture.startGoalSessionExecution).toHaveBeenCalledWith(expect.objectContaining({
      slug: fixture.project.slug,
      workspaceRoot,
      sessionId: goal.mainSessionId,
      input: { kind: "direct", text: expect.stringContaining(goal.acceptanceCriteria) },
      origin: "goal_claim",
    }));
  });

  test("retry rejects non-terminal Goals, active families, and request bodies", async () => {
    const running = makeGoal();
    const runningFixture = createFixture([running]);
    const runningResponse = await runningFixture.app.request(
      `/api/projects/${runningFixture.project.slug}/goals/${running.id}/retry`,
      { method: "POST" },
    );

    const failed = makeGoal({ status: "failed" });
    const activeFixture = createFixture([failed], "running");
    const activeResponse = await activeFixture.app.request(
      `/api/projects/${activeFixture.project.slug}/goals/${failed.id}/retry`,
      { method: "POST" },
    );
    const bodyResponse = await activeFixture.app.request(
      `/api/projects/${activeFixture.project.slug}/goals/${failed.id}/retry`,
      { method: "POST", body: "{}" },
    );

    expect(runningResponse.status).toBe(409);
    expect(activeResponse.status).toBe(409);
    expect(bodyResponse.status).toBe(400);
  });

  test("cancels through the runtime lifecycle capability", async () => {
    const goal = makeGoal();
    const fixture = createFixture([goal]);

    const response = await fixture.app.request(
      `/api/projects/${fixture.project.slug}/goals/${goal.id}/cancel`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(fixture.cancelGoal).toHaveBeenCalledWith(workspaceRoot, goal.id, { source: "http" });
    expect(await response.json()).toMatchObject({ status: "cancelled" });
  });

  test("validates Goal IDs and maps missing Goals to 404", async () => {
    const fixture = createFixture([]);
    const invalid = await fixture.app.request(`/api/projects/${fixture.project.slug}/goals/not-a-uuid`);
    const missing = await fixture.app.request(`/api/projects/${fixture.project.slug}/goals/${crypto.randomUUID()}`);

    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
  });
});

function createFixture(goals: GoalState[], activity: "idle" | "running" = "idle") {
  const project: ProjectInfo = {
    slug: "test-project",
    name: "Test Project",
    workspaceRoot,
    addedAt: new Date().toISOString(),
  };
  const read = mock(async (goalId: string) => {
    const goal = goals.find((candidate) => candidate.id === goalId);
    if (goal !== undefined) return goal;
    const error = new Error(`Goal not found: ${goalId}`);
    error.name = "GoalNotFoundError";
    throw error;
  });
  const retry = mock(async (goalId: string) => ({ ...await read(goalId), status: "running" as const }));
  const cancelGoal = mock(async (_root: string, goalId: string) => ({
    ...await read(goalId),
    status: "cancelled" as const,
  }));
  const modelRuntimeFixture = new ModelRuntime();
  const agent = { model: "local:test" };
  const snapshot = modelRuntimeFixture.prepare({
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local",
        options: { baseURL: "http://localhost.invalid/v1" },
        models: {
          test: {
            name: "Test",
            limit: { context: 64_000, output: 4_096 },
            modalities: { input: ["text"], output: ["text"] },
            capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
          },
        },
      },
    },
    agents: {
      engineer: agent, goal_lead: agent, plan: agent, build: agent,
      reviewer: agent, explore: agent, librarian: agent, shaper: agent,
    },
  }, "goal-route-test-runtime");
  const modelInfo = snapshot.tryResolveSelection({ model: "local:test" })!.modelInfo;
  const startGoalSessionExecution = mock(async (input: Parameters<AgentRuntime["startGoalSessionExecution"]>[0]): Promise<ActiveSessionExecution> => ({
    sessionId: input.sessionId,
    rootSessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    agentName: "goal_lead",
    origin: "goal_claim",
    abortController: new AbortController(),
    promise: Promise.resolve(),
    started: Promise.resolve(),
    executionToken: Symbol("goal-route-test-execution"),
    startedAt: Date.now(),
    executionId: input.executionId ?? "goal-route-test-execution",
    binding: {
      modelInfo,
      options: undefined,
      summary: {
        selection: { model: "local:test" },
        providerId: "local",
        modelId: "test",
        providerDisplayName: "Local",
        modelDisplayName: "Test",
        resolution: "agent_default",
        modelRuntimeRevision: "test",
      },
    },
  }));
  const context = {
    project,
    goalState: {
      listGoals: mock(async () => goals),
      read,
    },
    goalLifecycle: {
      retry,
      fail: mock(async (goalId: string) => ({ ...await read(goalId), status: "failed" as const })),
    },
  } as unknown as ProjectContext;
  const runtime = {
    projectRegistry: { get: mock(async (slug: string) => slug === project.slug ? project : undefined) },
    contextResolver: { resolve: mock(async () => context) },
    getSessionFamilyActivity: mock(() => activity),
    startGoalSessionExecution,
    cancelGoal,
  } as unknown as AgentRuntime;
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/projects", createGoalsRoutes(runtime));
  return { app, project, goals, retry, startGoalSessionExecution, cancelGoal };
}

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    projectSlug: "test-project",
    createdFromSessionId: crypto.randomUUID(),
    title: "Committed Goal",
    objective: "Complete the requested work.",
    acceptanceCriteria: "The requested behavior is verified.",
    useWorktree: false,
    status: "running",
    attempt: 1,
    reviewGeneration: 0,
    appliedBudgetHitlIds: [],
    mainSessionId: crypto.randomUUID(),
    childSessionIds: [],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    startedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}
