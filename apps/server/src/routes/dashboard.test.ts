import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { Automation, AutomationInvocation, SessionExecutionRecord, SessionExecutionTerminalStatus, SessionGoal, SessionSummary } from "@archcode/protocol";
import { createDashboardRoutes } from "./dashboard";

const workspaceRoot = process.cwd();

function goal(status: SessionGoal["status"] = "blocked"): SessionGoal {
  return {
    instanceId: "goal", generation: 1, objective: "Finish the migration and run all tests.", status,
    usage: { tokens: { inputTokens: 10, outputTokens: 20, totalTokens: 30, reasoningTokens: 0, cachedInputTokens: 0 }, executionTimeMs: 90_000, executionCount: 2 },
    settlementReceipts: [],
    createdAt: 1, activatedAt: 1, updatedAt: 2,
  };
}

function rootSummary(sessionId = "root"): SessionSummary {
  return {
    sessionId, cwd: workspaceRoot, rootSessionId: sessionId, agentName: "lead", profile: "principal", activeSkillNames: [],
    modelSelection: { revision: 0 }, title: "Migration", goal: goal(), createdAt: 1, updatedAt: 2,
  };
}

function execution(status: SessionExecutionTerminalStatus | "running" = "failed"): SessionExecutionRecord {
  const binding = {
    selection: { model: "test:model" }, providerId: "test", modelId: "model",
    providerDisplayName: "Test", modelDisplayName: "Model", resolution: "profile_default" as const, modelRuntimeRevision: "test-revision",
  };
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
  if (status === "running") {
    return {
      id: "execution-1", status, startedAt: 10, durationMs: 0, maxSteps: 50, origin: "user_message",
      runs: [{ ordinal: 0, startedAt: 10, binding }],
    };
  }
  return {
    id: "execution-1", status, startedAt: 10, endedAt: 20,
    durationMs: 10, maxSteps: 50, origin: "user_message",
    runs: [{ ordinal: 0, startedAt: 10, endedAt: 20, durationMs: 10, binding, usageDelta: usage, settlement: { key: "run:root:execution-1:0", goalInstanceId: null } }],
    terminalSettlement: { key: "terminal:root:execution-1", goalInstanceId: null },
  };
}

function automation(id = "automation-1"): Automation {
  return {
    id, projectSlug: "demo", createdFromSessionId: "root", name: "Deploy", status: "active",
    trigger: { kind: "interval", everyMs: 60_000 }, action: { kind: "start_session", message: "run", location: "project" },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T01:00:00.000Z", nextFireAt: "2026-01-01T02:00:00.000Z",
  };
}

function invocation(): AutomationInvocation {
  return {
    id: "invocation-1", automationId: "automation-1", dueAt: "2026-01-01T00:00:00.000Z", status: "failed",
    sessionId: "root", createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z", error: "secret failure detail",
  };
}

function runtime(overrides: Record<string, unknown> = {}) {
  const project = { slug: "demo", name: "Demo", workspaceRoot, addedAt: "now" };
  return {
    projectRegistry: {
      get: mock(async (slug: string) => slug === project.slug ? project : undefined),
      list: mock(async () => [project]),
    },
    listSessions: mock(async () => [rootSummary(), { ...rootSummary("child"), parentSessionId: "root", rootSessionId: "root", agentName: "analyst" }]),
    getSessionFile: mock(async () => ({ ...rootSummary(), executions: [execution()] })),
    listAutomations: mock(async () => [automation()]),
    listAutomationInvocations: mock(async () => [invocation()]),
    ...overrides,
  } as unknown as Parameters<typeof createDashboardRoutes>[0];
}

describe("DashboardProjection routes", () => {
  test("uses one global read model rooted in Session and Automation owners", async () => {
    const app = new Hono().route("/api", createDashboardRoutes(runtime()));

    const response = await app.request("/api/dashboard");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scope: { kind: "global" },
      sessions: [{
        projectSlug: "demo", projectName: "Demo", rootSessionId: "root", sessionTitle: "Migration", createdAt: 1, updatedAt: 2,
        goal: goal(), latestExecution: { id: "execution-1", status: "failed", startedAt: 10, endedAt: 20 },
      }],
      automations: [{
        projectSlug: "demo", projectName: "Demo", id: "automation-1", name: "Deploy", status: "active",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T01:00:00.000Z", nextFireAt: "2026-01-01T02:00:00.000Z",
        latestInvocation: { id: "invocation-1", status: "failed", sessionId: "root", createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z" },
      }],
      errors: [],
    });
  });

  test("uses the same projection contract for one project", async () => {
    const app = new Hono().route("/api", createDashboardRoutes(runtime()));

    const response = await app.request("/api/projects/demo/dashboard");

    expect(response.status).toBe(200);
    expect((await response.json() as { scope: unknown }).scope).toEqual({ kind: "project", projectSlug: "demo" });
  });

  test("isolates a corrupt project while preserving other global project rows", async () => {
    const good = { slug: "good", name: "Good", workspaceRoot, addedAt: "now" };
    const bad = { slug: "bad", name: "Bad", workspaceRoot: "/bad", addedAt: "now" };
    const app = new Hono().route("/api", createDashboardRoutes(runtime({
      projectRegistry: { get: mock(async (slug: string) => slug === "good" ? good : slug === "bad" ? bad : undefined), list: mock(async () => [good, bad]) },
      listSessions: mock(async (root: string) => root === "/bad" ? Promise.reject(new Error("session file is corrupt")) : [rootSummary()]),
    })));

    const response = await app.request("/api/dashboard");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessions: [{ projectSlug: "good" }],
      errors: [{ projectSlug: "bad", projectName: "Bad", message: "session file is corrupt" }],
    });
  });

  test("uses only latest Session and Invocation records so recovered work leaves attention", async () => {
    const app = new Hono().route("/api", createDashboardRoutes(runtime({
      getSessionFile: mock(async () => ({
        ...rootSummary(),
        executions: [execution("failed"), {
          ...execution("running"),
          id: "execution-2",
          startedAt: 30,
          runs: [{ ordinal: 0, startedAt: 30, binding: {
            selection: { model: "test:model" }, providerId: "test", modelId: "model",
            providerDisplayName: "Test", modelDisplayName: "Model", resolution: "profile_default", modelRuntimeRevision: "test-revision",
          } }],
        }],
      })),
      listAutomationInvocations: mock(async () => [
        invocation(),
        { ...invocation(), id: "invocation-2", status: "dispatched", createdAt: "2026-01-01T00:02:00.000Z" },
      ]),
    })));

    const response = await app.request("/api/dashboard");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessions: [{ latestExecution: { id: "execution-2", status: "running" } }],
      automations: [{ latestInvocation: { id: "invocation-2", status: "dispatched" } }],
    });
  });

  test("isolates an Automation projection failure without dropping a healthy project", async () => {
    const good = { slug: "good", name: "Good", workspaceRoot, addedAt: "now" };
    const bad = { slug: "bad", name: "Bad", workspaceRoot: "/bad", addedAt: "now" };
    const app = new Hono().route("/api", createDashboardRoutes(runtime({
      projectRegistry: {
        get: mock(async (slug: string) => slug === "good" ? good : slug === "bad" ? bad : undefined),
        list: mock(async () => [good, bad]),
      },
      listSessions: mock(async () => [rootSummary()]),
      listAutomations: mock(async (root: string) => root === "/bad" ? [automation("bad-automation")] : [automation("good-automation")]),
      listAutomationInvocations: mock(async (root: string) => {
        if (root === "/bad") throw new Error("automation invocation is corrupt");
        return [invocation()];
      }),
    })));

    const response = await app.request("/api/dashboard");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessions: [{ projectSlug: "good" }],
      automations: [{ projectSlug: "good", id: "good-automation" }],
      errors: [{ projectSlug: "bad", projectName: "Bad", message: "automation invocation is corrupt" }],
    });
  });
});
