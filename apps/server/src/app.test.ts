import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime } from "@archcode/agent-core";
import type { GlobalSSEEvent, McpServerStatus } from "@archcode/protocol";
import { createServerApp } from "./app";
import { globalEventBus } from "./events/global-event-bus";

const mockRuntime = {
  configService: {
    getSnapshot: mock(async () => ({ config: { provider: {}, agents: {} }, revision: "test", modelRuntimeRevision: "test", configPath: "/test", restartRequiredSections: [] })),
    getModelRuntimeCatalog: mock(() => ({ revision: "test", providers: [], agentDefaults: {} })),
    getProviderAdapterCatalog: mock(() => []),
    save: mock(async () => ({ config: { provider: {}, agents: {} }, revision: "test", modelRuntimeRevision: "test", configPath: "/test", restartRequiredSections: [] })),
  },
  listAgentDescriptors: mock(() => []),
  subscribeSessionEvents: mock(() => () => undefined),
  subscribeHitlEvents: mock(() => () => undefined),
  subscribeSessionRuntimeChanges: mock(() => () => undefined),
  subscribeMcpStatusChanges: mock(() => () => undefined),
  subscribeModelRuntimeChanges: mock(() => () => undefined),
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
    const runtime = { ...mockRuntime, listAgentDescriptors: mock(() => [{ name: "engineer", displayName: "Engineer" }]) } as unknown as AgentRuntime;
    const response = await createServerApp(runtime, { dev: true }).app.request("/api/agents");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agents: [{ name: "engineer", displayName: "Engineer" }] });
  });

  test("adds wildcard CORS headers in dev mode", async () => {
    const res = await createServerApp(mockRuntime, { dev: true }).app.request("/api/health", { headers: { Origin: "http://localhost:5173" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("requires Basic auth when configured", async () => {
    const app = createServerApp(mockRuntime, { dev: true, password: "secret" }).app;
    expect((await app.request("/api/health")).status).toBe(401);
    expect((await app.request("/api/health", { headers: { Authorization: `Basic ${btoa("user:secret")}` } })).status).toBe(200);
  });

  test("wires runtime session events exactly once through the global bus", () => {
    const observed: GlobalSSEEvent[] = [];
    const runtime = {
      ...mockRuntime,
      subscribeSessionEvents: mock((listener: (event: GlobalSSEEvent) => void) => {
        listener({ type: "event", slug: "proj", sessionId: "session-1", eventId: 1, createdAt: 1, agentName: "engineer", payload: {
          type: "execution-start",
          executionId: "run-1",
          binding: {
            selection: { model: "local:test" },
            providerId: "local",
            modelId: "test",
            providerDisplayName: "Local",
            modelDisplayName: "Test",
            resolution: "agent_default",
            modelRuntimeRevision: "test",
          },
          origin: "user_message",
        } });
        listener({ type: "event", slug: "proj", sessionId: "session-1", eventId: 2, createdAt: 2, agentName: "engineer", payload: { type: "execution-end", status: "completed" } });
        return () => undefined;
      }),
    } as unknown as AgentRuntime;
    const unsubscribe = globalEventBus.subscribe((event) => observed.push(event));
    createServerApp(runtime, { dev: true });
    expect(runtime.subscribeSessionEvents).toHaveBeenCalledTimes(1);
    expect(observed.map((event) => event.type === "event" ? event.payload.type : event.type)).toEqual(["execution-start", "execution-end"]);
    unsubscribe();
  });

  test("bridges MCP status changes", () => {
    let listener: ((name: string, status: McpServerStatus) => void) | undefined;
    const runtime = {
      ...mockRuntime,
      subscribeMcpStatusChanges: mock((next: typeof listener) => { listener = next; return () => undefined; }),
    } as unknown as AgentRuntime;
    const observed: GlobalSSEEvent[] = [];
    const unsubscribe = globalEventBus.subscribe((event) => observed.push(event));
    createServerApp(runtime, { dev: true });
    listener!("context7", { state: "ready", toolCount: 1 });
    expect(observed[0]).toMatchObject({ type: "mcp_status", serverName: "context7" });
    unsubscribe();
  });

  test("bridges ModelRuntime revision changes", () => {
    let listener: ((event: Extract<GlobalSSEEvent, { type: "model_runtime.changed" }>) => void) | undefined;
    const runtime = {
      ...mockRuntime,
      subscribeModelRuntimeChanges: mock((next: typeof listener) => { listener = next; return () => undefined; }),
    } as unknown as AgentRuntime;
    const observed: GlobalSSEEvent[] = [];
    const unsubscribe = globalEventBus.subscribe((event) => observed.push(event));
    createServerApp(runtime, { dev: true });
    listener!({ type: "model_runtime.changed", revision: "revision-2", createdAt: 2 });
    expect(observed[0]).toEqual({ type: "model_runtime.changed", revision: "revision-2", createdAt: 2 });
    unsubscribe();
  });
});
