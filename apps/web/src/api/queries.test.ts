import { afterEach, describe, expect, mock, test } from "bun:test";
import type { GoalState, HitlRequest, LoopRunReport, LoopState, SessionSummary, SessionTreeResponse } from "@archcode/protocol";
import type { DashboardGoal, DashboardLoop } from "./types";
import { activeGoalsQueryOptions, activeLoopsQueryOptions, focusedSessionQueryOptions, goalQueryOptions, goalsQueryOptions, hitlQueryOptions, loopQueryOptions, loopRunsQueryOptions, loopStateQueryOptions, loopsQueryOptions, projectHitlQueryOptions, queryKeys, sessionTreeQueryOptions, sessionsQueryOptions } from "./queries";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
type QueryOptionWithFn<T> = { queryFn: (context?: unknown) => Promise<T> };

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
      expect(String(input)).toBe("/api/projects/archcode/sessions");
      return jsonResponse({ sessions: [rootSession, childSession] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (sessionsQueryOptions("archcode") as unknown as QueryOptionWithFn<unknown[]>).queryFn();

    expect(result).toEqual([
      {
        id: "root-session",
        sessionId: "root-session",
        rootSessionId: "root-session",
        parentSessionId: undefined,
        goalId: "goal-root",
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
      expect(String(input)).toBe("/api/projects/archcode/sessions/child-session");
      return jsonResponse(serverResponse);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (focusedSessionQueryOptions("archcode", "child-session") as unknown as QueryOptionWithFn<unknown>).queryFn();

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
    const opts = focusedSessionQueryOptions("archcode", null);
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
      expect(String(input)).toBe("/api/projects/archcode/sessions/root-session/tree");
      return jsonResponse(tree);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (sessionTreeQueryOptions("archcode", "root-session") as unknown as QueryOptionWithFn<SessionTreeResponse>).queryFn();

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
        projectId: "archcode",
        title: "Test Goal",
        status: "draft",
        phase: "plan",
        doneConditions: [],
        doneResults: {},
        reviewerAgent: "reviewer",
        retryPolicy: { maxRetries: 3, backoffMs: 5000, escalateOnFailure: true },
        retryCount: 0,
        approvalPoints: [],
        author: "user",
        childSessionIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/projects/archcode/goals");
      return jsonResponse({ goals });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = goalsQueryOptions("archcode");
    const result = await (opts as unknown as QueryOptionWithFn<GoalState[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", "archcode", "goals"]);
    expect(result).toEqual(goals);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("goalQueryOptions fetches a single goal by goalId", async () => {
    globalThis.document = { cookie: "" } as Document;
    const goal: GoalState = {
      id: "goal-1",
      projectId: "archcode",
      title: "Single Goal",
      status: "locked",
      phase: "plan",
      doneConditions: [],
      doneResults: {},
      reviewerAgent: "reviewer",
      retryPolicy: { maxRetries: 3, backoffMs: 5000, escalateOnFailure: true },
      retryCount: 0,
      approvalPoints: [],
      author: "user",
      childSessionIds: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/projects/archcode/goals/goal-1");
      return jsonResponse(goal);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = goalQueryOptions("archcode", "goal-1");
    const result = await (opts as unknown as QueryOptionWithFn<GoalState>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", "archcode", "goals", "goal-1"]);
    expect(result).toEqual(goal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("queryKeys.goal is keyed by goalId", () => {
    expect(queryKeys.goal("archcode", "goal-abc")).toEqual([
      "projects",
      "archcode",
      "goals",
      "goal-abc",
    ]);
  });

  test("hitlQueryOptions fetches global pending HITL requests", async () => {
    globalThis.document = { cookie: "" } as Document;
    const hitl: HitlRequest[] = [
      {
        id: "hitl-1",
        sessionId: "session-1",
        kind: "approval",
        prompt: "Approve?",
        payload: { kind: "approval", action: "run_tool", context: {} },
        trigger: "agent_request",
        status: "pending",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/hitl?status=pending");
      return jsonResponse({ hitl });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = hitlQueryOptions();
    const result = await (opts as unknown as QueryOptionWithFn<HitlRequest[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["hitl", "pending"]);
    expect(result).toEqual(hitl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("projectHitlQueryOptions fetches project-scoped HITL requests", async () => {
    globalThis.document = { cookie: "" } as Document;
    const hitl: HitlRequest[] = [
      {
        id: "hitl-2",
        sessionId: "session-1",
        goalId: "goal-1",
        kind: "review",
        prompt: "Review artifacts",
        payload: { kind: "review", artifacts: [] },
        trigger: "approval_point",
        status: "pending",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/projects/archcode/hitl");
      return jsonResponse({ hitl });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = projectHitlQueryOptions("archcode");
    const result = await (opts as unknown as QueryOptionWithFn<HitlRequest[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", "archcode", "hitl"]);
    expect(result).toEqual(hitl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("queryKeys.hitl is keyed correctly", () => {
    expect(queryKeys.hitl).toEqual(["hitl", "pending"]);
    expect(queryKeys.projectHitl("archcode")).toEqual(["projects", "archcode", "hitl"]);
  });

  test("activeGoalsQueryOptions fetches global active goals with project metadata", async () => {
    globalThis.document = { cookie: "" } as Document;
    const goals: DashboardGoal[] = [
      {
        id: "goal-1",
        projectId: "archcode",
        title: "Active Goal",
        status: "running",
        phase: "build",
        doneConditions: [],
        doneResults: {},
        reviewerAgent: "reviewer",
        retryPolicy: { maxRetries: 3, backoffMs: 5000, escalateOnFailure: true },
        retryCount: 0,
        approvalPoints: [],
        author: "user",
        childSessionIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        projectSlug: "archcode",
        projectName: "ArchCode",
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
        projectId: "archcode",
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
      expect(String(input)).toBe("/api/projects/archcode/loops");
      return jsonResponse({ loops });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopsQueryOptions("archcode");
    const result = await (opts as unknown as QueryOptionWithFn<LoopState[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", "archcode", "loops"]);
    expect(result).toEqual(loops);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopQueryOptions fetches a single loop by loopId", async () => {
    globalThis.document = { cookie: "" } as Document;
    const loop: LoopState = {
      loopId: "loop-1",
      projectId: "archcode",
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
      expect(String(input)).toBe("/api/projects/archcode/loops/loop-1");
      return jsonResponse({ loop });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopQueryOptions("archcode", "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<LoopState>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", "archcode", "loops", "loop-1"]);
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
      expect(String(input)).toBe("/api/projects/archcode/loops/loop-1/runs");
      return jsonResponse({ runs });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopRunsQueryOptions("archcode", "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<LoopRunReport[]>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", "archcode", "loops", "loop-1", "runs"]);
    expect(result).toEqual(runs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loopStateQueryOptions fetches generated state for a loop", async () => {
    globalThis.document = { cookie: "" } as Document;
    const loop: LoopState = {
      loopId: "loop-1",
      projectId: "archcode",
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
      expect(String(input)).toBe("/api/projects/archcode/loops/loop-1/state");
      return jsonResponse(stateResponse);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const opts = loopStateQueryOptions("archcode", "loop-1");
    const result = await (opts as unknown as QueryOptionWithFn<{ markdown: string; state: LoopState }>).queryFn();

    expect([...opts.queryKey]).toEqual(["projects", "archcode", "loops", "loop-1", "state"]);
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
        projectSlug: "archcode",
        projectName: "ArchCode",
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
    expect(queryKeys.projectLoops("archcode")).toEqual(["projects", "archcode", "loops"]);
    expect(queryKeys.loop("archcode", "loop-abc")).toEqual(["projects", "archcode", "loops", "loop-abc"]);
    expect(queryKeys.loopRuns("archcode", "loop-abc")).toEqual(["projects", "archcode", "loops", "loop-abc", "runs"]);
    expect(queryKeys.loopState("archcode", "loop-abc")).toEqual(["projects", "archcode", "loops", "loop-abc", "state"]);
    expect(queryKeys.activeLoops).toEqual(["loops", "active"]);
  });
});
