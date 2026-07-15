import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime } from "@archcode/agent-core";
import type { GlobalSSEEvent, HitlView, McpServerStatus } from "@archcode/protocol";
import { createServerApp } from "./app";
import { globalEventBus } from "./events/global-event-bus";

const mockRuntime = {
  configService: {
    getSnapshot: mock(async () => ({ config: { provider: {}, agents: {} }, revision: "test", configPath: "/test", restartRequired: false })),
    save: mock(async () => ({ config: { provider: {}, agents: {} }, revision: "test", configPath: "/test", restartRequired: false })),
  },
  listAgentDescriptors: mock(() => []),
  subscribeHitlEvents: mock(() => () => undefined),
  subscribeSessionRuntimeChanges: mock(() => () => undefined),
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

  test("mounts the runtime Agent catalog endpoint", async () => {
    const runtime = {
      ...mockRuntime,
      listAgentDescriptors: mock(() => [{ name: "engineer", displayName: "Engineer" }]),
    } as unknown as AgentRuntime;
    const { app } = createServerApp(runtime, { dev: true });

    const response = await app.request("/api/agents");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agents: [{ name: "engineer", displayName: "Engineer" }] });
  });

  test("mounts Project Todo routes through the shared Project context", async () => {
    const todo = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Mounted Todo",
      body: "",
      status: "idea" as const,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const runtime = {
      ...mockRuntime,
      projectRegistry: {
        get: mock(async () => ({
          slug: "proj",
          name: "Project",
          workspaceRoot: "/tmp",
          addedAt: new Date().toISOString(),
        })),
      },
      contextResolver: {
        resolve: mock(async () => ({ todos: { listTodos: mock(async () => [todo]) } })),
      },
    } as unknown as AgentRuntime;
    const { app } = createServerApp(runtime, { dev: true });

    const response = await app.request("/api/projects/proj/todos");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ todos: [todo] });
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

  test("does not expose a project-scoped configuration endpoint", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true });

    const response = await app.request("/api/projects/example/config");

    expect(response.status).toBe(404);
  });

  test("mounts only the global configuration endpoint", async () => {
    const { app } = createServerApp(mockRuntime, { dev: true });

    const global = await app.request("/api/config");
    const project = await app.request("/api/projects/example/config");

    expect(global.status).toBe(200);
    expect(await global.json()).toMatchObject({ revision: "test", restartRequired: false });
    expect(project.status).toBe(404);
  });

  test("includes Session Family runtime state in the initial global snapshot", async () => {
    const snapshot: Extract<GlobalSSEEvent, { type: "session.runtime.snapshot" }> = {
      type: "session.runtime.snapshot",
      projectSlugs: ["proj"],
      families: [{ projectSlug: "proj", rootSessionId: "root-1", activity: "running" }],
      createdAt: 1,
    };
    const runtime = {
      subscribeHitlEvents: mock(() => () => undefined),
      subscribeSessionRuntimeChanges: mock(() => () => undefined),
      subscribeMcpStatusChanges: mock(() => () => undefined),
      getMcpServerStatuses: mock(() => new Map()),
      listHitlSnapshotEvents: mock(async () => []),
      listSessionRuntimeEvents: mock(async () => [snapshot]),
    } as unknown as AgentRuntime;
    const { app } = createServerApp(runtime, { dev: true });

    const response = await app.request("/api/events");
    const text = await readSSEUntil(response, "session.runtime.snapshot");

    expect(text).toContain("event: session.runtime.snapshot");
    expect(text).toContain('"rootSessionId":"root-1"');
    expect(runtime.listSessionRuntimeEvents).toHaveBeenCalledTimes(1);
  });

  test("recursively forwards child session events to global SSE", async () => {
    const runtime = createRuntimeWithManualSubscriptions();
    const { runtime: serverRuntime } = createServerApp(runtime, { dev: true });
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
      payload: { type: "text-delta", text: "live" },
      agentName: "explore",
    });

    expect(runtime.subscribedSessionIds()).toEqual(["root", "child"]);
    expect(observed.map((event) => event.type === "event" ? event.sessionId : event.type)).toEqual(["root", "child"]);

    runtime.emitSession("root", childLinkEvent("root", "child", "completed"));
    expect(runtime.subscribedSessionIds()).toEqual(["root"]);
    runtime.resolveExecution();
    await execution.promise;
    await runtime.waitForUnsubscribed();
    expect(runtime.subscribedSessionIds()).toEqual([]);
    unsubscribeBus();
  });

  test("forwards a cold managed tool-batch continuation without an earlier subscription", async () => {
    const runtime = createRuntimeWithManualSubscriptions();
    const { forwardSessionExecution } = createServerApp(runtime, { dev: true });
    const observed: GlobalSSEEvent[] = [];
    const unsubscribeBus = globalEventBus.subscribe((event) => observed.push(event));

    const input = {
      slug: "proj",
      workspaceRoot: "/workspace",
      sessionId: "root",
      userMessage: "",
      origin: "tool_batch" as const,
    };
    const execution = await forwardSessionExecution(
      input,
      () => runtime.startSessionMessageExecution(input),
    );
    expect(runtime.subscribedSessionIds()).toEqual(["root"]);

    runtime.emitSession("root", {
      type: "event",
      slug: "proj",
      sessionId: "root",
      eventId: 0,
      createdAt: 2,
      payload: { type: "text-delta", text: "continued" },
      agentName: "engineer",
    });
    expect(observed).toContainEqual(expect.objectContaining({
      type: "event",
      sessionId: "root",
      payload: { type: "text-delta", text: "continued" },
    }));

    runtime.resolveExecution();
    await execution.promise;
    await runtime.waitForUnsubscribed();
    unsubscribeBus();
  });

  test("keeps forwarding Session events across a durable HITL continuation", async () => {
    const runtime = createRuntimeWithManualSubscriptions();
    const { runtime: serverRuntime } = createServerApp(runtime, { dev: true });
    const observed: GlobalSSEEvent[] = [];
    const unsubscribeBus = globalEventBus.subscribe((event) => observed.push(event));

    const execution = serverRuntime.startSessionExecution({
      slug: "proj",
      workspaceRoot: "/workspace",
      sessionId: "root",
      userMessage: "run",
    });
    runtime.setActiveToolBatch(true);
    runtime.resolveExecution("waiting_for_human");
    await execution.promise;
    await Promise.resolve();

    expect(runtime.subscribedSessionIds()).toEqual(["root"]);
    runtime.emitSession("root", {
      type: "event",
      slug: "proj",
      sessionId: "root",
      eventId: 1,
      createdAt: 2,
      payload: { type: "tool-result", toolCallId: "call-1", toolName: "ask_user", output: "answered", isError: false },
      agentName: "engineer",
    });
    runtime.setExecutionStatus("running");
    runtime.setActiveToolBatch(false);
    const releaseChecksBeforeContinuation = runtime.sessionFileReadCount();
    runtime.emitSession("root", {
      type: "event",
      slug: "proj",
      sessionId: "root",
      eventId: 2,
      createdAt: 3,
      payload: { type: "tool-call", toolCallId: "call-2", toolName: "file_read", input: { path: "README.md" } },
      agentName: "engineer",
    });
    await runtime.waitForSessionFileReads(releaseChecksBeforeContinuation + 1);

    expect(runtime.subscribedSessionIds()).toEqual(["root"]);
    runtime.emitSession("root", {
      type: "event",
      slug: "proj",
      sessionId: "root",
      eventId: 3,
      createdAt: 4,
      payload: { type: "tool-result", toolCallId: "call-2", toolName: "file_read", output: "continued", isError: false },
      agentName: "engineer",
    });
    runtime.setExecutionStatus("completed");
    runtime.emitSession("root", {
      type: "event",
      slug: "proj",
      sessionId: "root",
      eventId: 4,
      createdAt: 5,
      payload: { type: "execution-end", status: "completed" },
      agentName: "engineer",
    });
    await runtime.waitForUnsubscribed();

    expect(observed.filter((event) => event.type === "event").map((event) => event.eventId)).toEqual([1, 2, 3, 4]);
    expect(runtime.subscribedSessionIds()).toEqual([]);
    unsubscribeBus();
  });
});

async function readSSEUntil(response: Response, expected: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Expected SSE response body");
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes(expected)) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out reading SSE")), 2_000)),
      ]);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    return text;
  } finally {
    await reader.cancel();
  }
}

function createRuntimeWithManualSubscriptions() {
  const subscriptions = new Map<string, (event: GlobalSSEEvent) => void>();
  let activeToolBatch = false;
  let executionStatus: "running" | "completed" | "waiting_for_human" = "running";
  let sessionFileReads = 0;
  const sessionFileReadWaiters: Array<{ minimum: number; resolve: () => void }> = [];
  let resolveExecution!: () => void;
  let resolveUnsubscribed!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveExecution = resolve;
  });
  const unsubscribed = new Promise<void>((resolve) => {
    resolveUnsubscribed = resolve;
  });

  const runtime = {
    subscribeSessionEvents: mock((input: { sessionId: string; onEvent: (event: GlobalSSEEvent) => void }) => {
      subscriptions.set(input.sessionId, input.onEvent);
      return () => {
        subscriptions.delete(input.sessionId);
        if (subscriptions.size === 0) resolveUnsubscribed();
      };
    }),
    subscribeHitlEvents: mock(() => () => undefined),
    subscribeSessionRuntimeChanges: mock(() => () => undefined),
    startSessionExecution: mock(() => ({ promise })),
    startSessionMessageExecution: mock(async () => ({ promise })),
    getSessionFile: mock(async () => {
      sessionFileReads += 1;
      for (const waiter of sessionFileReadWaiters.splice(0)) {
        if (sessionFileReads >= waiter.minimum) waiter.resolve();
        else sessionFileReadWaiters.push(waiter);
      }
      return {
        toolBatches: activeToolBatch ? [{ batchId: "batch-1" }] : [],
        executions: [{ id: "execution-1", startedAt: 1, status: executionStatus }],
      };
    }),
    emitSession: (sessionId: string, event: GlobalSSEEvent) => subscriptions.get(sessionId)?.(event),
    subscribedSessionIds: () => [...subscriptions.keys()],
    resolveExecution: (status: "completed" | "waiting_for_human" = "completed") => {
      executionStatus = status;
      resolveExecution();
    },
    setExecutionStatus: (status: "running" | "completed" | "waiting_for_human") => { executionStatus = status; },
    setActiveToolBatch: (active: boolean) => { activeToolBatch = active; },
    sessionFileReadCount: () => sessionFileReads,
    waitForSessionFileReads: (minimum: number) => sessionFileReads >= minimum
      ? Promise.resolve()
      : new Promise<void>((resolve) => { sessionFileReadWaiters.push({ minimum, resolve }); }),
    waitForUnsubscribed: () => unsubscribed,
  };

  return runtime as unknown as AgentRuntime & {
    emitSession: (sessionId: string, event: GlobalSSEEvent) => void;
    subscribedSessionIds: () => string[];
    resolveExecution: (status?: "completed" | "waiting_for_human") => void;
    setExecutionStatus: (status: "running" | "completed" | "waiting_for_human") => void;
    setActiveToolBatch: (active: boolean) => void;
    sessionFileReadCount: () => number;
    waitForSessionFileReads: (minimum: number) => Promise<void>;
    waitForUnsubscribed: () => Promise<void>;
  };
}

describe("MCP status SSE bridge", () => {
  test("emits mcp_status events to globalEventBus when runtime reports status changes", () => {
    let mcpListener: ((serverName: string, status: McpServerStatus) => void) | undefined;
    const runtime = {
      subscribeHitlEvents: mock(() => () => undefined),
      subscribeSessionRuntimeChanges: mock(() => () => undefined),
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
      subscribeSessionRuntimeChanges: mock(() => () => undefined),
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
      subscribeSessionRuntimeChanges: mock(() => () => undefined),
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

describe("Session Family runtime SSE bridge", () => {
  test("emits runtime changes without leaking workspace paths", () => {
    let runtimeListener: ((event: Extract<GlobalSSEEvent, { type: "session.runtime_changed" }>) => void) | undefined;
    const runtime = {
      subscribeHitlEvents: mock(() => () => undefined),
      subscribeMcpStatusChanges: mock(() => () => undefined),
      getMcpServerStatuses: mock(() => new Map<string, McpServerStatus>()),
      subscribeSessionRuntimeChanges: mock((listener: typeof runtimeListener) => {
        runtimeListener = listener;
        return () => {
          runtimeListener = undefined;
        };
      }),
    } as unknown as AgentRuntime;
    const observed: GlobalSSEEvent[] = [];
    const unsubscribeBus = globalEventBus.subscribe((event) => observed.push(event));

    createServerApp(runtime, { dev: true });
    runtimeListener!({
      type: "session.runtime_changed",
      projectSlug: "proj",
      rootSessionId: "root-1",
      activity: "stopping",
      createdAt: 10,
    });

    expect(observed).toContainEqual({
      type: "session.runtime_changed",
      projectSlug: "proj",
      rootSessionId: "root-1",
      activity: "stopping",
      createdAt: 10,
    });
    expect(JSON.stringify(observed)).not.toContain("workspace");
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
    agentName: "engineer",
  };
}

function hitlRealtimeEvent(): Extract<GlobalSSEEvent, { type: "hitl.event" }> {
  const view: HitlView = { hitlId: "hitl-1", owner: { type: "session", id: "session-1" }, source: { type: "ask_user", toolCallId: "call-1" }, status: "pending", displayPayload: { title: "Need input", redacted: true }, allowedActions: ["answer", "cancel"], createdAt: "2026-07-08T00:00:00.000Z", updatedAt: "2026-07-08T00:00:00.000Z" };
  return {
    type: "hitl.event",
    projectSlug: "proj",
    hitlId: view.hitlId,
    createdAt: 1,
    payload: { type: "hitl.request" },
    view,
  };
}
