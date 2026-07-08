import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime } from "@archcode/agent-core";
import type { GlobalSSEEvent, HitlRecord, McpServerStatus } from "@archcode/protocol";
import { createServerApp, createServerEventRuntime } from "./app";
import { globalEventBus } from "./events/global-event-bus";

const mockRuntime = {
  subscribeHitlEvents: mock(() => () => undefined),
  subscribeMcpStatusChanges: mock(() => () => undefined),
  getMcpServerStatuses: mock(() => new Map()),
} as unknown as AgentRuntime;

describe("createServerApp", () => {
  test("returns the health endpoint response", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true });

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("adds wildcard CORS headers in dev mode", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true });

    const res = await app.request("/api/health", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("requires Basic auth for API routes when a password is configured", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true, password: "secret" });

    const res = await app.request("/api/health");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });

  test("accepts Basic auth when the password matches", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true, password: "secret" });

    const res = await app.request("/api/health", {
      headers: { Authorization: `Basic ${btoa("user:secret")}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("does not expose legacy deferred question or permission response routes", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true });

    const permission = await app.request("/api/permissions/legacy-id", { method: "POST" });
    const question = await app.request("/api/questions/legacy-id", { method: "POST" });

    expect(permission.status).toBe(404);
    expect(question.status).toBe(404);
  });

  test("recursively forwards child session events to global SSE", async () => {
    const runtime = createRuntimeWithManualSubscriptions();
    const serverRuntime = createServerEventRuntime(runtime);
    const observed: GlobalSSEEvent[] = [];
    const unsubscribeBus = globalEventBus.subscribe((event) => observed.push(event));

    const execution = serverRuntime.startSessionExecution({
      slug: "proj",
      workspaceRoot: "/workspace",
      sessionId: "root",
      userMessage: "run",
    });

    runtime.emitSession("root", childLinkEvent("root", "child", "running"));
    runtime.emitSession("child", {
      type: "event",
      slug: "proj",
      sessionId: "child",
      eventId: 0,
      createdAt: 2,
      kind: "text-delta",
      payload: { type: "text-delta", text: "live" },
      agentName: "explore",
    });

    expect(runtime.subscribedSessionIds()).toEqual(["root", "child"]);
    expect(observed.map((event) => event.type === "event" ? event.sessionId : event.type)).toEqual(["root", "child"]);

    runtime.emitSession("root", childLinkEvent("root", "child", "completed"));
    expect(runtime.subscribedSessionIds()).toEqual(["root"]);
    runtime.resolveExecution();
    await execution.promise;
    expect(runtime.subscribedSessionIds()).toEqual([]);
    unsubscribeBus();
  });
});

function createRuntimeWithManualSubscriptions() {
  const subscriptions = new Map<string, (event: GlobalSSEEvent) => void>();
  let resolveExecution!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveExecution = resolve;
  });

  const runtime = {
    subscribeSessionEvents: mock((input: { sessionId: string; onEvent: (event: GlobalSSEEvent) => void }) => {
      subscriptions.set(input.sessionId, input.onEvent);
      return () => subscriptions.delete(input.sessionId);
    }),
    subscribeHitlEvents: mock(() => () => undefined),
    startSessionExecution: mock(() => ({ promise })),
    emitSession: (sessionId: string, event: GlobalSSEEvent) => subscriptions.get(sessionId)?.(event),
    subscribedSessionIds: () => [...subscriptions.keys()],
    resolveExecution: () => resolveExecution(),
  };

  return runtime as unknown as AgentRuntime & {
    emitSession: (sessionId: string, event: GlobalSSEEvent) => void;
    subscribedSessionIds: () => string[];
    resolveExecution: () => void;
  };
}

describe("MCP status SSE bridge", () => {
  test("emits mcp_status events to globalEventBus when runtime reports status changes", () => {
    let mcpListener: ((serverName: string, status: McpServerStatus) => void) | undefined;
    const runtime = {
      subscribeHitlEvents: mock(() => () => undefined),
      subscribeMcpStatusChanges: mock((listener: (serverName: string, status: McpServerStatus) => void) => {
        mcpListener = listener;
        return () => {
          mcpListener = undefined;
        };
      }),
      getMcpServerStatuses: mock(() => new Map<string, McpServerStatus>()),
    } as unknown as AgentRuntime;

    const observed: GlobalSSEEvent[] = [];
    const unsubscribeBus = globalEventBus.subscribe((event) => observed.push(event));

    createServerApp(runtime, { dev: true });

    expect(mcpListener).toBeDefined();
    expect(typeof mcpListener).toBe("function");

    const readyStatus: McpServerStatus = { state: "ready", toolCount: 4 };
    mcpListener!("context7", readyStatus);

    expect(observed).toHaveLength(1);
    const event = observed[0];
    expect(event.type).toBe("mcp_status");
    if (event.type === "mcp_status") {
      expect(event.serverName).toBe("context7");
      expect(event.status).toEqual(readyStatus);
      expect(typeof event.createdAt).toBe("number");
    }

    unsubscribeBus();
  });

  test("globalEventBus subscribers receive mcp_status events emitted via the bridge", () => {
    let mcpListener: ((serverName: string, status: McpServerStatus) => void) | undefined;
    const runtime = {
      subscribeHitlEvents: mock(() => () => undefined),
      subscribeMcpStatusChanges: mock((listener: (serverName: string, status: McpServerStatus) => void) => {
        mcpListener = listener;
        return () => {
          mcpListener = undefined;
        };
      }),
      getMcpServerStatuses: mock(() => new Map<string, McpServerStatus>()),
    } as unknown as AgentRuntime;

    const received: GlobalSSEEvent[] = [];
    const unsubscribe = globalEventBus.subscribe((event) => {
      if (event.type === "mcp_status") received.push(event);
    });

    createServerApp(runtime, { dev: true });

    const failedStatus: McpServerStatus = { state: "failed", error: "timeout" };
    mcpListener!("exa", failedStatus);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "mcp_status",
      serverName: "exa",
      status: failedStatus,
    });

    unsubscribe();
  });
});

describe("HITL realtime SSE bridge", () => {
  test("emits projection-safe hitl.event payloads to globalEventBus", () => {
    let hitlListener: ((event: Extract<GlobalSSEEvent, { type: "hitl.event" }>) => void) | undefined;
    const runtime = {
      subscribeHitlEvents: mock((listener: (event: Extract<GlobalSSEEvent, { type: "hitl.event" }>) => void) => {
        hitlListener = listener;
        return () => {
          hitlListener = undefined;
        };
      }),
      subscribeMcpStatusChanges: mock(() => () => undefined),
      getMcpServerStatuses: mock(() => new Map<string, McpServerStatus>()),
    } as unknown as AgentRuntime;

    const observed: GlobalSSEEvent[] = [];
    const unsubscribeBus = globalEventBus.subscribe((event) => observed.push(event));

    createServerApp(runtime, { dev: true });

    expect(hitlListener).toBeDefined();
    const event = hitlRealtimeEvent();
    hitlListener!(event);

    expect(observed).toEqual([event]);
    unsubscribeBus();
  });
});

function childLinkEvent(parentSessionId: string, childSessionId: string, status: "running" | "completed"): GlobalSSEEvent {
  return {
    type: "event",
    slug: "proj",
    sessionId: parentSessionId,
    eventId: status === "running" ? 0 : 1,
    createdAt: Date.now(),
    kind: "tool-child-session-link",
    payload: {
      type: "tool-child-session-link",
      link: {
        parentSessionId,
        parentToolCallId: "call-1",
        toolName: "delegate",
        childSessionId,
        childAgentName: "explore",
        depth: 1,
        background: true,
        status,
        createdAt: 1,
      },
    },
    agentName: "orchestrator",
  };
}

function hitlRealtimeEvent(): Extract<GlobalSSEEvent, { type: "hitl.event" }> {
  const record: HitlRecord = {
    hitlId: "hitl-1",
    owner: { projectSlug: "proj", ownerType: "session", ownerId: "session-1" } as const,
    blockingKey: "session:session-1:ask:call-1",
    source: { type: "ask_user", sessionId: "session-1", toolCallId: "call-1" } as const,
    status: "pending" as const,
    displayPayload: {
      title: "Need input",
      questions: [{ header: "Q1", question: "Continue?", options: [], custom: true as const }],
      redacted: true as const,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
  return {
    type: "hitl.event",
    projectSlug: "proj",
    owner: record.owner,
    hitlId: record.hitlId,
    createdAt: 1,
    payload: { type: "hitl.request", status: "pending" },
    projection: {
      hitlId: record.hitlId,
      project: { slug: "proj" },
      owner: record.owner,
      source: record.source,
      status: record.status,
      displayPayload: record.displayPayload,
      allowedActions: ["answer", "cancel"],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
}
