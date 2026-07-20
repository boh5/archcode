import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentDescriptor, SessionGoal, SessionSummary } from "@archcode/protocol";
import { agentsQueryOptions, diffQueryOptions, queryKeys, sessionGoalsQueryOptions, sessionsQueryOptions } from "./queries";

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
    evaluatorCount: 0, noProgressCount: 0, failureCount: 0, userInputCursor: 1, sourceMutationEpoch: 0,
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

  test("projects dashboard Goal state from Sessions, not a Goal resource", async () => {
    globalThis.document = { cookie: "" } as Document;
    const sessionGoals = [{ sessionId: "root", sessionTitle: "Root", updatedAt: 2, projectSlug: slug, projectName: "Test", goal: { objective: "Complete it", status: "active", tokensUsed: 3, timeUsedSeconds: 1 } }];
    globalThis.fetch = mock(async (input) => {
      expect(String(input)).toBe("/api/session-goals");
      return jsonResponse({ sessionGoals });
    }) as unknown as typeof fetch;
    const options = sessionGoalsQueryOptions();
    expect([...options.queryKey]).toEqual(["session-goals"]);
    expect(await (options as unknown as QueryOptionWithFn<typeof sessionGoals>).queryFn()).toEqual(sessionGoals);
    expect(queryKeys).not.toHaveProperty("goal");
    expect(queryKeys).not.toHaveProperty("projectGoals");
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
