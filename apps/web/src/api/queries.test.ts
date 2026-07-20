import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentDescriptor, DashboardProjection, SessionGoal, SessionSummary } from "@archcode/protocol";
import { agentsQueryOptions, dashboardProjectionQueryOptions, diffQueryOptions, queryKeys, sessionsQueryOptions } from "./queries";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const slug = "test-project";
type QueryOptionWithFn<T> = { queryFn: (context?: unknown) => Promise<T> };

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function goal(): SessionGoal {
  return {
    instanceId: "goal-1", generation: 1, objective: "Complete the migration and run tests.", status: "active",
    usage: { tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 0, cachedInputTokens: 0 }, executionTimeMs: 500, executionCount: 1 },
    createdAt: 1, activatedAt: 1, updatedAt: 1,
  };
}

describe("web Session Goal query contracts", () => {
  test("fetches the global Agent catalog", async () => {
    globalThis.document = { cookie: "" } as Document;
    const agents: AgentDescriptor[] = [{ name: "engineer", displayName: "Engineer" }];
    globalThis.fetch = mock(async (input) => {
      expect(String(input)).toBe("/api/agents");
      return jsonResponse({ agents });
    }) as unknown as typeof fetch;
    expect(await (agentsQueryOptions() as unknown as QueryOptionWithFn<AgentDescriptor[]>).queryFn()).toEqual(agents);
  });

  test("returns Session summaries with their Session-owned Goal", async () => {
    globalThis.document = { cookie: "" } as Document;
    const sessions: SessionSummary[] = [{
      sessionId: "root", cwd: "/workspace", rootSessionId: "root", agentName: "engineer", activeSkillNames: [],
      modelSelection: { revision: 0 }, title: "Root", goal: goal(), createdAt: 1, updatedAt: 2,
    }];
    globalThis.fetch = mock(async (input) => {
      expect(String(input)).toBe(`/api/projects/${slug}/sessions`);
      return jsonResponse({ sessions });
    }) as unknown as typeof fetch;
    expect(await (sessionsQueryOptions(slug) as unknown as QueryOptionWithFn<SessionSummary[]>).queryFn()).toEqual(sessions);
  });

  test("fetches the shared Dashboard projection in global scope", async () => {
    globalThis.document = { cookie: "" } as Document;
    const projection: DashboardProjection = { scope: { kind: "global" }, sessions: [], automations: [], errors: [] };
    globalThis.fetch = mock(async (input) => {
      expect(String(input)).toBe("/api/dashboard");
      return jsonResponse(projection);
    }) as unknown as typeof fetch;
    const options = dashboardProjectionQueryOptions({ kind: "global" });
    expect([...options.queryKey]).toEqual(["dashboard", "global"]);
    expect(await (options as unknown as QueryOptionWithFn<DashboardProjection>).queryFn()).toEqual(projection);
  });

  test("fetches the same Dashboard projection contract in project scope", async () => {
    globalThis.document = { cookie: "" } as Document;
    const projection: DashboardProjection = { scope: { kind: "project", projectSlug: "demo space" }, sessions: [], automations: [], errors: [] };
    globalThis.fetch = mock(async (input) => {
      expect(String(input)).toBe("/api/projects/demo%20space/dashboard");
      return jsonResponse(projection);
    }) as unknown as typeof fetch;
    const options = dashboardProjectionQueryOptions({ kind: "project", projectSlug: "demo space" });
    expect([...options.queryKey]).toEqual(["dashboard", "project", "demo space"]);
    expect(await (options as unknown as QueryOptionWithFn<DashboardProjection>).queryFn()).toEqual(projection);
    expect(queryKeys).not.toHaveProperty("sessionGoals");
    expect(queryKeys).not.toHaveProperty("activeAutomations");
  });

  test("keeps Diff scoped to a Session", async () => {
    globalThis.document = { cookie: "" } as Document;
    globalThis.fetch = mock(async (input) => {
      expect(String(input)).toBe(`/api/projects/${slug}/diff?sessionId=root`);
      return jsonResponse({ files: [] });
    }) as unknown as typeof fetch;
    expect(await (diffQueryOptions(slug, "root") as unknown as QueryOptionWithFn<unknown[]>).queryFn()).toEqual([]);
  });
});
