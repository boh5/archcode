import { afterEach, describe, expect, mock, test } from "bun:test";
import type { GoalState, HitlProjection, LoopRunReport, LoopState, SessionSummary, SessionTreeResponse } from "@archcode/protocol";
import type { DashboardGoal, DashboardLoop } from "./types";
import { activeGoalsQueryOptions, activeLoopsQueryOptions, focusedSessionQueryOptions, goalQueryOptions, goalsQueryOptions, loopBudgetQueryOptions, loopCollisionsQueryOptions, loopIntegrationsQueryOptions, loopKillStateQueryOptions, loopQueryOptions, loopRunsQueryOptions, loopStateQueryOptions, loopsQueryOptions, projectHitlQueryOptions, queryKeys, sessionTreeQueryOptions, sessionsQueryOptions } from "./queries";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
type QueryOptionWithFn<T> = { queryFn: (context?: unknown) => Promise<T> };
const TEST_PROJECT_SLUG = "test-project";
const TEST_PROJECT_NAME = "Test Project";

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("web session query contracts", () => {
  test("sessionsQueryOptions normalizes identity fields and preserves root-only server list", async () => {
    globalThis.document = { cookie: "" } as Document;
    const rootSession: SessionSummary = {
      sessionId: "root-session",
      rootSessionId: "root-session",
      goalId: "goal-root",
      loopId: "loop-root",
      title: "Root",
      createdAt: 1_000,
      lastUpdatedAt: 2_000,
    };
    const childSession: SessionSummary = {
      sessionId: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      title: "Child",
      createdAt: 1_500,
      lastUpdatedAt: 1_700,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions`);
      return jsonResponse({ sessions: [rootSession, childSession] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (sessionsQueryOptions(TEST_PROJECT_SLUG) as unknown as QueryOptionWithFn<unknown[]>).queryFn();

    expect(result).toEqual([
      {
        id: "root-session",
        sessionId: "root-session",
        rootSessionId: "root-session",
        parentSessionId: undefined,
        goalId: "goal-root",
        loopId: "loop-root",
        title: "Root",
        createdAt: 1_000,
        updatedAt: 2_000,
        lastUpdatedAt: 2_000,
      },
      {
        id: "child-session",
        sessionId: "child-session",
        rootSessionId: "root-session",
        parentSessionId: "root-session",
        title: "Child",
        createdAt: 1_500,
        updatedAt: 1_700,
        lastUpdatedAt: 1_700,
      },
    ]);
  });

  test("focusedSessionQueryOptions fetches a single child session and normalizes identity", async () => {
    globalThis.document = { cookie: "" } as Document;
    const serverResponse = {
      sessionId: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      title: "Focused Child",
      createdAt: 1_000,
      lastUpdatedAt: 2_000,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions/child-session`);
      return jsonResponse(serverResponse);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (focusedSessionQueryOptions(TEST_PROJECT_SLUG, "child-session") as unknown as QueryOptionWithFn<unknown>).queryFn();

    expect(result).toMatchObject({
      id: "child-session",
      sessionId: "child-session",
      rootSessionId: "root-session",
      title: "Focused Child",
      createdAt: 1_000,
      updatedAt: 2_000,
      lastUpdatedAt: 2_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("focusedSessionQueryOptions is disabled when focusSessionId is null", () => {
    const opts = focusedSessionQueryOptions(TEST_PROJECT_SLUG, null);
    expect(opts.enabled).toBe(false);
  });

  test("sessionTreeQueryOptions fetches the root tree endpoint and returns child identity", async () => {
    globalThis.document = { cookie: "" } as Document;
    const tree: SessionTreeResponse = {
      root: {
        session: { sessionId: "root-session", rootSessionId: "root-session", title: "Root", createdAt: 1_000 },
        children: [
          {
            session: {
              sessionId: "child-session",
              rootSessionId: "root-session",
              parentSessionId: "root-session",
              title: "Child",
              createdAt: 2_000,
            },
            children: [],
          },
        ],
      },
      diagnostics: [],
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions/root-session/tree`);
      return jsonResponse(tree);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (sessionTreeQueryOptions(TEST_PROJECT_SLUG, "root-session") as unknown as QueryOptionWithFn<SessionTreeResponse>).queryFn();

    expect(result.root.children[0].session).toMatchObject({
      sessionId: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("goalsQueryOptions fetches project goals and returns GoalState array", async () => {
    globalThis.document = { cookie: "" } as Document;
    const goals: GoalState[] = [
      {
        id: "goal-1",
        projectId: TEST_PROJECT_SLUG,
        title: "Test Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        status: "draft",
        attempt: 1,
        pendingHitlIds: [],
        approvalRefs: [],
        childSessionIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/goals`);
      return jsonResponse({ goals });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = goalsQueryOptions(TEST_PROJECT_SLUG);
    const result = await (opts as unknown as QueryOptionWithFn<GoalState[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "goals"]);
    expect(result).toEqual(goals);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("goalQueryOptions fetches a single goal by goalId", async () => {
    globalThis.document = { cookie: "" } as Document;
    const goal: GoalState = {
      id: "goal-1",
      projectId: TEST_PROJECT_SLUG,
      title: "Single Goal",
      objective: "Simplify the Goal experience",
      acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
      status: "running",
      attempt: 1,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/goals/goal-1`);
      return jsonResponse(goal);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = goalQueryOptions(TEST_PROJECT_SLUG, "goal-1");
    const result = await (opts as unknown as QueryOptionWithFn<GoalState>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "goals", "goal-1"]);
    expect(result).toEqual(goal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("queryKeys.goal is keyed by goalId", () => {
    expect(queryKeys.goal(TEST_PROJECT_SLUG, "goal-abc")).toEqual([
      "projects",
      TEST_PROJECT_SLUG,
      "goals",
      "goal-abc",
    ]);
  });

  test("projectHitlQueryOptions fetches project-scoped HITL via canonical scoped endpoint", async () => {
    globalThis.document = { cookie: "" } as Document;
    const hitl: HitlProjection[] = [
      {
        hitlId: "hitl-2",
        project: { slug: TEST_PROJECT_SLUG, name: TEST_PROJECT_NAME },
        owner: { projectSlug: TEST_PROJECT_SLUG, ownerType: "goal", ownerId: "goal-1" },
        source: { type: "goal_review", goalId: "goal-1" },
        status: "pending",
        displayPayload: { title: "Review artifacts", redacted: true },
        allowedActions: ["approve", "deny", "cancel"],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe(`/api/projects/${TEST_PROJECT_SLUG}/hitl?scope=project&status=pending`);
      return jsonResponse({ hitl });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = projectHitlQueryOptions(TEST_PROJECT_SLUG);
    const result = await (opts as unknown as QueryOptionWithFn<HitlProjection[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "hitl"]);
    expect(result).toEqual(hitl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("projectHitlQueryOptions never fetches global /api/hitl?status=pending", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).not.toBe("/api/hitl?status=pending");
      expect(url).not.toMatch(/^\/api\/hitl\b/);
      expect(url).toBe(`/api/projects/${TEST_PROJECT_SLUG}/hitl?scope=project&status=pending`);
      return jsonResponse({ hitl: [] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = projectHitlQueryOptions(TEST_PROJECT_SLUG);
    await (opts as unknown as QueryOptionWithFn<HitlProjection[]>).queryFn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("queryKeys.projectHitl is keyed correctly", () => {
    expect(queryKeys.projectHitl(TEST_PROJECT_SLUG)).toEqual(["projects", TEST_PROJECT_SLUG, "hitl"]);
  });

  test("activeGoalsQueryOptions fetches global active goals with project metadata", async () => {
    globalThis.document = { cookie: "" } as Document;
    const goals: DashboardGoal[] = [
      {
        id: "goal-1",
        projectId: TEST_PROJECT_SLUG,
        title: "Active Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        status: "running",
        attempt: 1,
        pendingHitlIds: [],
        approvalRefs: [],
        childSessionIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        projectSlug: TEST_PROJECT_SLUG,
        projectName: TEST_PROJECT_NAME,
      },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/goals?status=active");
      return jsonResponse({ goals });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = activeGoalsQueryOptions();
    const result = await (opts as unknown as QueryOptionWithFn<DashboardGoal[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["goals", "active"]);
    expect(result).toEqual(goals);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("queryKeys.activeGoals is keyed correctly", () => {
    expect(queryKeys.activeGoals).toEqual(["goals", "active"]);
  });
});

describe("web loop query contracts", () => {
  test("loopsQueryOptions fetches project loops and returns LoopState array", async () => {
    globalThis.document = { cookie: "" } as Document;
    const loops: LoopState[] = [
      {
        loopId: "loop-1",
        projectId: TEST_PROJECT_SLUG,
        config: {
          title: "Test Loop",
          description: "A test loop",
          schedule: { kind: "manual" },
          runKind: "session",
          mode: "report",
          approvalPolicy: "interactive",
          limits: { maxIterationsPerRun: 10 },
        },
        status: "active",
        createdAt: 1_000,
        updatedAt: 2_000,
        runCount: 0,
        stateVersion: 1,
      },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops`);
      return jsonResponse({ loops });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopsQueryOptions(TEST_PROJECT_SLUG);
    const result = await (opts as unknown as QueryOptionWithFn<LoopState[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "loops"]);
    expect(result).toEqual(loops);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopQueryOptions fetches a single loop by loopId", async () => {
    globalThis.document = { cookie: "" } as Document;
    const loop: LoopState = {
      loopId: "loop-1",
      projectId: TEST_PROJECT_SLUG,
      config: {
        title: "Single Loop",
        schedule: { kind: "manual" },
        runKind: "session",
        mode: "report",
        approvalPolicy: "interactive",
        limits: { maxIterationsPerRun: 10 },
      },
      status: "active",
      createdAt: 1_000,
      updatedAt: 2_000,
      runCount: 0,
      stateVersion: 1,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1`);
      return jsonResponse({ loop });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopQueryOptions(TEST_PROJECT_SLUG, "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<LoopState>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-1"]);
    expect(result).toEqual(loop);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopRunsQueryOptions fetches run log for a loop", async () => {
    globalThis.document = { cookie: "" } as Document;
    const runs: LoopRunReport[] = [
      {
        runId: "run-1",
        loopId: "loop-1",
        status: "succeeded",
        trigger: "manual",
        startedAt: 1_000,
        endedAt: 2_000,
      },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/runs`);
      return jsonResponse({ runs });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopRunsQueryOptions(TEST_PROJECT_SLUG, "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<LoopRunReport[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "runs"]);
    expect(result).toEqual(runs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopStateQueryOptions fetches generated state for a loop", async () => {
    globalThis.document = { cookie: "" } as Document;
    const loop: LoopState = {
      loopId: "loop-1",
      projectId: TEST_PROJECT_SLUG,
      config: {
        title: "State Loop",
        schedule: { kind: "manual" },
        runKind: "session",
        mode: "report",
        approvalPolicy: "interactive",
        limits: { maxIterationsPerRun: 10 },
      },
      status: "active",
      createdAt: 1_000,
      updatedAt: 2_000,
      runCount: 0,
      stateVersion: 1,
    };
    const stateResponse = { markdown: "# State", state: loop };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/state`);
      return jsonResponse(stateResponse);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopStateQueryOptions(TEST_PROJECT_SLUG, "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<{ markdown: string; state: LoopState }>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "state"]);
    expect(result).toEqual(stateResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("activeLoopsQueryOptions fetches dashboard active loops", async () => {
    globalThis.document = { cookie: "" } as Document;
    const loops: DashboardLoop[] = [
      {
        loopId: "loop-1",
        title: "Active Loop",
        status: "active",
        runKind: "session",
        mode: "report",
        projectSlug: TEST_PROJECT_SLUG,
        projectName: TEST_PROJECT_NAME,
      },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/loops?status=active");
      return jsonResponse({ loops });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = activeLoopsQueryOptions();
    const result = await (opts as unknown as QueryOptionWithFn<DashboardLoop[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["loops", "active"]);
    expect(result).toEqual(loops);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("queryKeys include project slug and loopId", () => {
    expect(queryKeys.projectLoops(TEST_PROJECT_SLUG)).toEqual(["projects", TEST_PROJECT_SLUG, "loops"]);
    expect(queryKeys.loop(TEST_PROJECT_SLUG, "loop-abc")).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-abc"]);
    expect(queryKeys.loopRuns(TEST_PROJECT_SLUG, "loop-abc")).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-abc", "runs"]);
    expect(queryKeys.loopState(TEST_PROJECT_SLUG, "loop-abc")).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-abc", "state"]);
    expect(queryKeys.loopBudget(TEST_PROJECT_SLUG, "loop-abc")).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-abc", "budget"]);
    expect(queryKeys.loopCollisions(TEST_PROJECT_SLUG, "loop-abc")).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-abc", "collisions"]);
    expect(queryKeys.loopIntegrations(TEST_PROJECT_SLUG, "loop-abc")).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-abc", "integrations"]);
    expect(queryKeys.loopKillState(TEST_PROJECT_SLUG)).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "kill-state"]);
    expect(queryKeys.activeLoops).toEqual(["loops", "active"]);
  });
});

describe("web loop guardrail query contracts", () => {
  test("loopBudgetQueryOptions fetches budget snapshot", async () => {
    globalThis.document = { cookie: "" } as Document;
    const budget = {
      usage: { iterations: 5, inputTokens: 1000, outputTokens: 500, totalTokens: 1500, wallClockMs: 60000, runsToday: 1, resetDateUtc: "2026-07-05" },
      updatedAt: 1_000,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/budget`);
      return jsonResponse({ loopId: "loop-1", budget });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopBudgetQueryOptions(TEST_PROJECT_SLUG, "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<unknown>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "budget"]);
    expect(result).toEqual(budget);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopBudgetQueryOptions returns null when no budget exists", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/budget`);
      return jsonResponse({ loopId: "loop-1", budget: null });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopBudgetQueryOptions(TEST_PROJECT_SLUG, "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<unknown>).queryFn();

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopCollisionsQueryOptions fetches collision snapshot", async () => {
    globalThis.document = { cookie: "" } as Document;
    const collisions = {
      targets: [],
      activeLeases: [],
      conflicts: [],
      updatedAt: 1_000,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/collisions`);
      return jsonResponse({ loopId: "loop-1", collisions });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopCollisionsQueryOptions(TEST_PROJECT_SLUG, "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<unknown>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "collisions"]);
    expect(result).toEqual(collisions);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopIntegrationsQueryOptions fetches integration status snapshot", async () => {
    globalThis.document = { cookie: "" } as Document;
    const integrations = {
      statuses: [
        { integrationId: "github", status: "ready", updatedAt: 1_000 },
      ],
      snapshot: null,
      updatedAt: 1_000,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/loop-1/integrations`);
      return jsonResponse({ loopId: "loop-1", integrations });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopIntegrationsQueryOptions(TEST_PROJECT_SLUG, "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<unknown>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "loop-1", "integrations"]);
    expect(result).toEqual(integrations);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopKillStateQueryOptions fetches kill state", async () => {
    globalThis.document = { cookie: "" } as Document;
    const killState = { globalKillActive: false };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/loops/kill-state`);
      return jsonResponse({ killState });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopKillStateQueryOptions(TEST_PROJECT_SLUG);
    const result = await (opts as unknown as QueryOptionWithFn<unknown>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "loops", "kill-state"]);
    expect(result).toEqual(killState);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopKillStateQueryOptions is disabled when slug is empty", () => {
    const opts = loopKillStateQueryOptions("");
    expect(opts.enabled).toBe(false);
  });
});
