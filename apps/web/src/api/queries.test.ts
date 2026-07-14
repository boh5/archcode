import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentDescriptor, GoalState, HitlProjection, SessionSummary, SessionTreeResponse } from "@archcode/protocol";
import type { DashboardGoal } from "./types";
import { activeGoalsQueryOptions, agentsQueryOptions, diffQueryOptions, focusedSessionQueryOptions, goalQueryOptions, goalsQueryOptions, projectHitlQueryOptions, queryKeys, sessionTreeQueryOptions, sessionsQueryOptions } from "./queries";

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
  test("agentsQueryOptions fetches the global Agent descriptor catalog", async () => {
    globalThis.document = { cookie: "" } as Document;
    const agents: AgentDescriptor[] = [
      { name: "engineer", displayName: "Engineer" },
      { name: "goal_lead", displayName: "Goal Lead" },
      { name: "plan", displayName: "Plan" },
      { name: "build", displayName: "Build" },
      { name: "reviewer", displayName: "Reviewer" },
      { name: "explore", displayName: "Explore" },
      { name: "librarian", displayName: "Librarian" },
    ];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/agents");
      return jsonResponse({ agents });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const options = agentsQueryOptions();
    const result = await (options as unknown as QueryOptionWithFn<AgentDescriptor[]>).queryFn();

    expect([...options.queryKey]).toEqual(["agents"]);
    expect(result).toEqual(agents);
  });

  test("diffQueryOptions scopes the cache and request to the Session", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/diff?sessionId=session-1`);
      return jsonResponse({ files: [] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const options = diffQueryOptions(TEST_PROJECT_SLUG, "session-1");
    const result = await (options as unknown as QueryOptionWithFn<unknown[]>).queryFn();

    expect([...options.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "diff", "session-1"]);
    expect(result).toEqual([]);
  });

  test("diffQueryOptions keeps project-level Diff when no Session route is active", async () => {
    globalThis.document = { cookie: "" } as Document;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/diff`);
      return jsonResponse({ files: [] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const options = diffQueryOptions(TEST_PROJECT_SLUG, "");
    const result = await (options as unknown as QueryOptionWithFn<unknown[]>).queryFn();

    expect([...options.queryKey]).toEqual(["projects", TEST_PROJECT_SLUG, "diff", "project"]);
    expect(options.enabled).toBe(true);
    expect(result).toEqual([]);
  });

  test("diffQueryOptions rejects the removed bare-array response shape", async () => {
    globalThis.document = { cookie: "" } as Document;
    globalThis.fetch = mock(async () => jsonResponse([])) as unknown as typeof fetch;

    const options = diffQueryOptions(TEST_PROJECT_SLUG);

    await expect((options as unknown as QueryOptionWithFn<unknown[]>).queryFn()).rejects.toThrow(
      "Diff response must use canonical { files } shape",
    );
  });

  test("sessionsQueryOptions returns the canonical Session summaries", async () => {
    globalThis.document = { cookie: "" } as Document;
    const rootSession: SessionSummary = {
      sessionId: "root-session",
      cwd: "/workspace",
      rootSessionId: "root-session",
      agentName: "goal_lead",
      modelInfo: null,
      goalId: "goal-root",
      title: "Root",
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const childSession: SessionSummary = {
      sessionId: "child-session",
      cwd: "/workspace",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      agentName: "explore",
      modelInfo: null,
      title: "Child",
      createdAt: 1_500,
      updatedAt: 1_700,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions`);
      return jsonResponse({ sessions: [rootSession, childSession] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (sessionsQueryOptions(TEST_PROJECT_SLUG) as unknown as QueryOptionWithFn<unknown[]>).queryFn();

    expect(result).toEqual([
      {
        sessionId: "root-session",
        cwd: "/workspace",
        rootSessionId: "root-session",
        parentSessionId: undefined,
        agentName: "goal_lead",
        modelInfo: null,
        goalId: "goal-root",
        title: "Root",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      {
        sessionId: "child-session",
        cwd: "/workspace",
        rootSessionId: "root-session",
        parentSessionId: "root-session",
        agentName: "explore",
        modelInfo: null,
        title: "Child",
        createdAt: 1_500,
        updatedAt: 1_700,
      },
    ]);
  });

  test("focusedSessionQueryOptions returns the canonical Session response", async () => {
    globalThis.document = { cookie: "" } as Document;
    const serverResponse = {
      sessionId: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      title: "Focused Child",
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/projects/${TEST_PROJECT_SLUG}/sessions/child-session`);
      return jsonResponse(serverResponse);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await (focusedSessionQueryOptions(TEST_PROJECT_SLUG, "child-session") as unknown as QueryOptionWithFn<unknown>).queryFn();

    expect(result).toMatchObject({
      sessionId: "child-session",
      rootSessionId: "root-session",
      title: "Focused Child",
      createdAt: 1_000,
      updatedAt: 2_000,
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
        session: { sessionId: "root-session", cwd: "/workspace", rootSessionId: "root-session", agentName: "engineer", modelInfo: null, title: "Root", createdAt: 1_000, updatedAt: 1_000 },
        children: [
          {
            session: {
              sessionId: "child-session",
              cwd: "/workspace",
              rootSessionId: "root-session",
              parentSessionId: "root-session",
              agentName: "explore",
              modelInfo: null,
              title: "Child",
              createdAt: 2_000,
              updatedAt: 2_000,
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
        version: 4,
        id: "goal-1",
        projectId: TEST_PROJECT_SLUG,
        createdFromSessionId: "session-origin",
        title: "Test Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        useWorktree: false,
        status: "running",
        attempt: 1,
        reviewGeneration: 0,
        pendingHitlIds: [],
        approvalRefs: [],
        appliedHitlIds: [],
        childSessionIds: [],
        mainSessionId: "session-main",
        startedAt: "2026-01-01T00:00:00Z",
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
      version: 4,
      id: "goal-1",
      projectId: TEST_PROJECT_SLUG,
      createdFromSessionId: "session-origin",
      title: "Single Goal",
      objective: "Simplify the Goal experience",
      acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
      useWorktree: false,
      status: "running",
      attempt: 1,
      reviewGeneration: 0,
      pendingHitlIds: [],
      approvalRefs: [],
      appliedHitlIds: [],
      childSessionIds: [],
      mainSessionId: "session-main",
      startedAt: "2026-01-01T00:00:00Z",
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
        source: { type: "goal_review", goalId: "goal-1", reviewGeneration: 1, reviewerSessionId: "reviewer-1" },
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
        version: 4,
        id: "goal-1",
        projectId: TEST_PROJECT_SLUG,
        createdFromSessionId: "session-origin",
        title: "Active Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        useWorktree: false,
        status: "running",
        attempt: 1,
        reviewGeneration: 0,
        pendingHitlIds: [],
        approvalRefs: [],
        appliedHitlIds: [],
        childSessionIds: [],
        mainSessionId: "session-main",
        startedAt: "2026-01-01T00:00:00Z",
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
