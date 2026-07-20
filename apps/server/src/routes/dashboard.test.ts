import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { SessionGoal, SessionSummary } from "@archcode/protocol";
import { createDashboardRoutes } from "./dashboard";

function goal(status: SessionGoal["status"]): SessionGoal {
  return {
    instanceId: "goal", generation: 1, objective: "Finish the migration and run all tests.", status,
    usage: { tokens: { inputTokens: 10, outputTokens: 20, totalTokens: 30, reasoningTokens: 0, cachedInputTokens: 0 }, executionTimeMs: 90_000, executionCount: 2 },
    evaluatorCount: 1, noProgressCount: 0, failureCount: 0, userInputCursor: 1, sourceMutationEpoch: 0,
    lastEvaluator: { decision: "continue", reason: "Tests are still running", evaluatedAt: 4 },
    createdAt: 1, activatedAt: 1, updatedAt: 2,
  };
}

describe("dashboard Session Goal projection", () => {
  test("reads Goal state from root Session summaries and has no Goal resource route", async () => {
    const root: SessionSummary = { sessionId: "root", cwd: "/repo", rootSessionId: "root", agentName: "engineer", activeSkillNames: [], modelSelection: { revision: 0 }, title: "Migration", goal: goal("active"), createdAt: 1, updatedAt: 2 };
    const child: SessionSummary = { ...root, sessionId: "child", parentSessionId: "root", agentName: "reviewer" };
    const runtime = {
      projectRegistry: { list: mock(async () => [{ slug: "demo", name: "Demo", workspaceRoot: "/repo", addedAt: "now" }]) },
      listSessions: mock(async () => [root, child]),
      listAutomations: mock(async () => []),
    } as unknown as Parameters<typeof createDashboardRoutes>[0];
    const app = new Hono().route("/api", createDashboardRoutes(runtime));

    const response = await app.request("/api/session-goals");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionGoals: [{
        sessionId: "root", sessionTitle: "Migration", updatedAt: 2, projectSlug: "demo", projectName: "Demo",
        goal: { objective: "Finish the migration and run all tests.", status: "active", tokensUsed: 30, timeUsedSeconds: 90, latestReason: "Tests are still running" },
      }],
      errors: [],
    });
    expect((await app.request("/api/goals")).status).toBe(404);
  });
});
