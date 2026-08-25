import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime } from "@archcode/agent-core";
import type { GlobalSSEEvent, McpServerStatus } from "@archcode/protocol";
import { createRuntimeApp } from "./app";
import { globalEventBus } from "./events/global-event-bus";

const mockRuntime = {
  listAgentDescriptors: mock(() => []),
  subscribeSessionEvents: mock(() => () => undefined),
  subscribeHitlEvents: mock(() => () => undefined),
  subscribeSessionRuntimeChanges: mock(() => () => undefined),
  subscribeMcpStatusChanges: mock(() => () => undefined),
  subscribeModelRuntimeChanges: mock(() => () => undefined),
  subscribeProjectCatalogChanges: mock(() => () => undefined),
  getMcpServerStatus: mock(() => ({ servers: {} })),
  getMcpServerInventory: mock(() => ({ servers: {} })),
} as unknown as AgentRuntime;

describe("createRuntimeApp", () => {
  test("mounts the runtime Agent catalog endpoint", async () => {
    const runtime = { ...mockRuntime, listAgentDescriptors: mock(() => [{ name: "lead", displayName: "Lead" }]) } as unknown as AgentRuntime;
    const response = await createRuntimeApp(runtime).app.request("/api/agents");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agents: [{ name: "lead", displayName: "Lead" }] });
  });

  test("wires runtime session events exactly once through the global bus", () => {
    const observed: GlobalSSEEvent[] = [];
    const runtime = {
      ...mockRuntime,
      subscribeSessionEvents: mock((listener: (event: GlobalSSEEvent) => void) => {
        listener({ type: "event", slug: "proj", sessionId: "session-1", eventId: 1, createdAt: 1, agentName: "lead", payload: {
          type: "execution-start",
          memoryPolicy: {
            policy: { useMemory: true, autoLearning: true },
            epoch: { bootId: "test-memory-boot", generation: 0 },
          },
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
          maxSteps: 50,
          executionSkills: [],
        } });
        listener({ type: "event", slug: "proj", sessionId: "session-1", eventId: 2, createdAt: 2, agentName: "lead", payload: {
          type: "execution-end",
          executionId: "run-1",
          terminalStatus: "completed",
          endedAt: 2,
          runEndedAt: 2,
          runUsageDelta: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
          runSettlement: { key: "run:session-1:run-1:0", goalInstanceId: null },
          terminalSettlement: { key: "terminal:session-1:run-1", goalInstanceId: null },
        } });
        return () => undefined;
      }),
    } as unknown as AgentRuntime;
    const unsubscribe = globalEventBus.subscribe((event) => observed.push(event));
    createRuntimeApp(runtime);
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
    createRuntimeApp(runtime);
    listener!("context7", { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 });
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
    createRuntimeApp(runtime);
    listener!({ type: "model_runtime.changed", revision: "revision-2", createdAt: 2 });
    expect(observed[0]).toEqual({ type: "model_runtime.changed", revision: "revision-2", createdAt: 2 });
    unsubscribe();
  });

  test("bridges project catalog changes", () => {
    let listener: ((event: Extract<GlobalSSEEvent, { type: "project.catalog_changed" }>) => void) | undefined;
    const runtime = {
      ...mockRuntime,
      subscribeProjectCatalogChanges: mock((next: typeof listener) => { listener = next; return () => undefined; }),
    } as unknown as AgentRuntime;
    const observed: GlobalSSEEvent[] = [];
    const unsubscribe = globalEventBus.subscribe((event) => observed.push(event));
    createRuntimeApp(runtime);
    listener!({ type: "project.catalog_changed", createdAt: 3 });
    expect(observed[0]).toEqual({ type: "project.catalog_changed", createdAt: 3 });
    unsubscribe();
  });
});
