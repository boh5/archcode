import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime } from "@archcode/agent-core";
import type { GlobalSSEEvent, McpServerStatus } from "@archcode/protocol";
import { createServerApp } from "./app";
import { globalEventBus } from "./events/global-event-bus";

const mockRuntime = {
  configService: {
    getSnapshot: mock(async () => ({ config: { provider: {}, profiles: {} }, revision: "test", modelRuntimeRevision: "test", configPath: "/test", restartRequiredSections: [] })),
    getModelRuntimeCatalog: mock(() => ({ revision: "test", providers: [], profileDefaults: {} })),
    getProviderAdapterCatalog: mock(() => []),
    save: mock(async () => ({ config: { provider: {}, profiles: {} }, revision: "test", modelRuntimeRevision: "test", configPath: "/test", restartRequiredSections: [] })),
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
    const { app } = createServerApp(mockRuntime, { dev: true, version: "1.2.3" });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "1.2.3" });
  });

  test("mounts the runtime Agent catalog endpoint", async () => {
    const runtime = { ...mockRuntime, listAgentDescriptors: mock(() => [{ name: "lead", displayName: "Lead" }]) } as unknown as AgentRuntime;
    const response = await createServerApp(runtime, { dev: true }).app.request("/api/agents");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agents: [{ name: "lead", displayName: "Lead" }] });
  });

  test("adds wildcard CORS headers in dev mode", async () => {
    const res = await createServerApp(mockRuntime, { dev: true }).app.request("/api/health", { headers: { Origin: "http://localhost:5173" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("serves explicitly injected Web assets outside development mode", async () => {
    const embeddedWebAssets = new Map([["/index.html", import.meta.path]]);
    const app = createServerApp(mockRuntime, { dev: false, embeddedWebAssets }).app;

    const indexResponse = await app.request("/");
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await indexResponse.text()).toContain("createServerApp");

    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect((await app.request("/api/health")).status).toBe(200);
  });

  test("rejects an embedded Web asset map without its SPA entrypoint", () => {
    expect(() => createServerApp(mockRuntime, {
      dev: false,
      embeddedWebAssets: new Map(),
    })).toThrow("Embedded Web assets must include /index.html");
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
        listener({ type: "event", slug: "proj", sessionId: "session-1", eventId: 1, createdAt: 1, agentName: "lead", payload: {
          type: "execution-start",
          executionId: "run-1",
          binding: {
            selection: { model: "local:test" },
            providerId: "local",
            modelId: "test",
            providerDisplayName: "Local",
            modelDisplayName: "Test",
            resolution: "profile_default",
            modelRuntimeRevision: "test",
          },
          origin: "user_message",
        } });
        listener({ type: "event", slug: "proj", sessionId: "session-1", eventId: 2, createdAt: 2, agentName: "lead", payload: { type: "execution-end", status: "completed" } });
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
    listener!("context7", { state: "ready", toolCount: 1, warningCount: 0 });
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
