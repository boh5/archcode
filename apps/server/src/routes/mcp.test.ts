import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime } from "@archcode/agent-core";
import type { McpServerStatus } from "@archcode/protocol";
import { createServerApp } from "../app";

interface McpStatusResponseBody {
  servers: Record<string, McpServerStatus>;
}

function createTestRuntime(statuses: Map<string, McpServerStatus>): AgentRuntime {
  return {
    projectRegistry: undefined,
    mcpManager: undefined,
    toolRegistry: undefined,
    skillService: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    subscribeSessionRuntimeChanges: mock(() => () => undefined),
    subscribeMcpStatusChanges: mock(() => () => undefined),
    getMcpServerStatuses: mock(() => statuses),
    createSession: async () => ({ sessionId: "session", title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] }),
    getSessionFile: async (_workspaceRoot: string, sessionId: string) => ({ sessionId, title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] }),
    listSessions: async () => [],
    startSessionExecution: () => {
      throw new Error("not implemented");
    },
    stopSessionFamily: async () => undefined,
    abortAllSessionExecutions: async () => undefined,
    getSessionFamilyActivity: () => "idle" as const,
    getSessionExecution: () => undefined,
    subscribeSessionEvents: () => () => undefined,
    deleteSession: async () => undefined,
    disposeSessionAgent: () => undefined,
    disposeAllSessionAgents: () => undefined,
    isSessionTombstoned: () => false,
    dispatchCommand: async () => null,
    notifyRuntimeShutdown: () => undefined,
  } as unknown as AgentRuntime;
}

describe("GET /api/mcp/status", () => {
  test("returns 200 with server statuses when MCP servers exist", async () => {
    const statuses = new Map<string, McpServerStatus>([
      ["context7", { state: "ready", toolCount: 3 }],
      ["exa", { state: "pending" }],
      ["broken", { state: "failed", error: "connection refused" }],
      ["disabled-server", { state: "disabled" }],
    ]);
    const runtime = createTestRuntime(statuses);
    const { app } = createServerApp(runtime, { dev: true });

    const res = await app.request("/api/mcp/status");
    const body = (await res.json()) as McpStatusResponseBody;

    expect(res.status).toBe(200);
    expect(body.servers).toEqual({
      "context7": { state: "ready", toolCount: 3 },
      "exa": { state: "pending" },
      "broken": { state: "failed", error: "connection refused" },
      "disabled-server": { state: "disabled" },
    });
  });

  test("returns 200 with empty servers object when no MCP servers configured", async () => {
    const runtime = createTestRuntime(new Map());
    const { app } = createServerApp(runtime, { dev: true });

    const res = await app.request("/api/mcp/status");
    const body = (await res.json()) as McpStatusResponseBody;

    expect(res.status).toBe(200);
    expect(body.servers).toEqual({});
  });

  test("returns correct pending/ready/failed states matching the runtime", async () => {
    const statuses = new Map<string, McpServerStatus>([
      ["pending-srv", { state: "pending" }],
      ["ready-srv", { state: "ready", toolCount: 5 }],
      ["failed-srv", { state: "failed", error: "boom" }],
    ]);
    const runtime = createTestRuntime(statuses);
    const { app } = createServerApp(runtime, { dev: true });

    const res = await app.request("/api/mcp/status");
    const body = (await res.json()) as McpStatusResponseBody;

    expect(res.status).toBe(200);
    expect(body.servers["pending-srv"]).toEqual({ state: "pending" });
    expect(body.servers["ready-srv"]).toEqual({ state: "ready", toolCount: 5 });
    expect(body.servers["failed-srv"]).toEqual({ state: "failed", error: "boom" });
  });

  test("route is mounted at /api/mcp/status (global, no project slug)", async () => {
    const runtime = createTestRuntime(new Map());
    const { app } = createServerApp(runtime, { dev: true });

    const res = await app.request("/api/mcp/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servers: {} });
  });

  test("old project-scoped path /api/projects/:slug/mcp/status no longer matches", async () => {
    const runtime = createTestRuntime(new Map());
    const { app } = createServerApp(runtime, { dev: true });

    const res = await app.request("/api/projects/my-project/mcp/status");

    expect(res.status).toBe(404);
  });
});
