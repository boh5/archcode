import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StoreApi } from "zustand";
import type {
  GoalState,
  GlobalSessionEventEnvelope,
  GlobalSSEHeartbeatEvent,
  GlobalSSEMcpStatusEvent,
  GlobalSSEResetEvent,
  GlobalSSELaggedEvent,
  GlobalSSEShutdownEvent,
  LoopState,
  McpServerStatus,
} from "@archcode/protocol";
import type { WebSessionStoreState } from "../store/session-store";
import { useMcpStatusStore } from "../store/mcp-status-store";
import { parseSSEEvent, handleSSEEvent } from "./global-sse";
import type { SSEEventHandlerDeps } from "./global-sse";

function createMockStore(): StoreApi<WebSessionStoreState> {
  return {
    getState: () => ({ applyRemoteEnvelope: mockApplyRemoteEnvelope } as unknown as WebSessionStoreState),
    subscribe: () => () => {},
    getInitialState: () => ({} as WebSessionStoreState),
  } as unknown as StoreApi<WebSessionStoreState>;
}

const mockApplyRemoteEnvelope = mock((_envelope: GlobalSessionEventEnvelope) => {});
const mockInitializeFromSnapshot = mock((_data: Partial<WebSessionStoreState>) => {});
const mockFindWebSessionStore = mock(
  (_sessionId: string, _slug?: string) => undefined as StoreApi<WebSessionStoreState> | undefined,
);
const mockCreateWebSessionStore = mock(
  (_sessionId: string, _slug?: string) => createMockStore(),
);
const mockInvalidateQueries = mock((_opts: { queryKey: readonly unknown[] }) => Promise.resolve());
const mockOnShutdown = mock(() => {});
const mockOnHeartbeat = mock((_createdAt: number) => {});
const mockRefreshMcpStatus = mock(() => {});

function createDeps(): SSEEventHandlerDeps {
  return {
    findStore: mockFindWebSessionStore,
    createStore: mockCreateWebSessionStore,
    invalidateQueries: mockInvalidateQueries,
    onShutdown: mockOnShutdown,
    onHeartbeat: mockOnHeartbeat,
    refreshMcpStatus: mockRefreshMcpStatus,
  };
}

describe("parseSSEEvent", () => {
  test("parses valid event type", () => {
    const data = JSON.stringify({ type: "event", slug: "p", sessionId: "s", eventId: 1, createdAt: 0, kind: "text-start", payload: { type: "text-start" } });
    const result = parseSSEEvent("event", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("event");
  });

  test("parses goal state change event payload", () => {
    const state = createGoalState("goal-1", "proj", "running");
    const payload = {
      type: "goal.state_change",
      goalId: state.id,
      status: state.status,
      state,
    } as const;
    const data = JSON.stringify({
      type: "event",
      slug: "p",
      sessionId: "s",
      eventId: 1,
      createdAt: 0,
      kind: payload.type,
      payload,
    });

    const result = parseSSEEvent("event", data);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("event");
    expect((result as GlobalSessionEventEnvelope).payload).toEqual(payload);
  });

  test("parses heartbeat event", () => {
    const data = JSON.stringify({ type: "heartbeat", createdAt: 123 });
    const result = parseSSEEvent("heartbeat", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("heartbeat");
  });

  test("parses reset event", () => {
    const data = JSON.stringify({ type: "reset", slug: "p", sessionId: "s", reason: "stale_cursor" });
    const result = parseSSEEvent("reset", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("reset");
  });

  test("parses lagged event", () => {
    const data = JSON.stringify({ type: "lagged", dropped: 5, reason: "client_backpressure" });
    const result = parseSSEEvent("lagged", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("lagged");
  });

  test("parses shutdown event", () => {
    const data = JSON.stringify({ type: "shutdown", reason: "server_shutdown" });
    const result = parseSSEEvent("shutdown", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("shutdown");
  });

  test("parses mcp_status event with serverName, status, and createdAt", () => {
    const status: McpServerStatus = { state: "ready", toolCount: 4 };
    const mcpEvent: GlobalSSEMcpStatusEvent = {
      type: "mcp_status",
      serverName: "context7",
      status,
      createdAt: 1700000000000,
    };
    const data = JSON.stringify(mcpEvent);

    const result = parseSSEEvent("mcp_status", data);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("mcp_status");
    const parsed = result as GlobalSSEMcpStatusEvent;
    expect(parsed.serverName).toBe("context7");
    expect(parsed.status).toEqual(status);
    expect(parsed.createdAt).toBe(1700000000000);
  });

  test("returns null for malformed JSON", () => {
    const result = parseSSEEvent("event", "not-json");
    expect(result).toBeNull();
  });

  test("returns null for unknown event type", () => {
    const result = parseSSEEvent("event", JSON.stringify({ type: "unknown" }));
    expect(result).toBeNull();
  });

  test("returns null for unknown SSE event name", () => {
    const result = parseSSEEvent("unknown-type", JSON.stringify({ type: "event" }));
    expect(result).not.toBeNull();
  });
});

describe("handleSSEEvent", () => {
  let deps: SSEEventHandlerDeps;

  beforeEach(() => {
    mockApplyRemoteEnvelope.mockClear();
    mockInitializeFromSnapshot.mockClear();
    mockFindWebSessionStore.mockClear();
    mockCreateWebSessionStore.mockClear();
    mockInvalidateQueries.mockClear();
    mockOnShutdown.mockClear();
    mockOnHeartbeat.mockClear();
    mockRefreshMcpStatus.mockClear();
    useMcpStatusStore.getState().clear();
    deps = createDeps();
  });

  test("routes event to matching session store via applyRemoteEnvelope", () => {
    const mockStore = createMockStore();
    mockFindWebSessionStore.mockReturnValue(mockStore);

    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "my-project",
      sessionId: "session-1",
      eventId: 42,
      createdAt: Date.now(),
      kind: "text-start",
      payload: { type: "text-start" },
      agentName: "orchestrator",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockFindWebSessionStore).toHaveBeenCalledWith("session-1", "my-project");
    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
  });

  test("creates a store when no matching session store exists", () => {
    mockFindWebSessionStore.mockReturnValue(undefined);
    const mockStore = createMockStore();
    mockCreateWebSessionStore.mockReturnValue(mockStore);

    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "my-project",
      sessionId: "unknown-session",
      eventId: 1,
      createdAt: Date.now(),
      kind: "text-start",
      payload: { type: "text-start" },
      agentName: "orchestrator",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockFindWebSessionStore).toHaveBeenCalledWith("unknown-session", "my-project");
    expect(mockCreateWebSessionStore).toHaveBeenCalledWith("unknown-session", "my-project");
    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
  });

  test("invalidates topology queries and preloads child metadata on child session link", () => {
    const parentStore = createMockStore();
    const childStore = {
      ...createMockStore(),
      getState: () => ({
        applyRemoteEnvelope: mockApplyRemoteEnvelope,
        initializeFromSnapshot: mockInitializeFromSnapshot,
      } as unknown as WebSessionStoreState),
    } as StoreApi<WebSessionStoreState>;
    parentStore.getState = () => ({
      applyRemoteEnvelope: mockApplyRemoteEnvelope,
      rootSessionId: "root-session",
    } as unknown as WebSessionStoreState);
    mockFindWebSessionStore.mockReturnValue(undefined);
    mockFindWebSessionStore.mockImplementation((sessionId) => sessionId === "parent-session" ? parentStore : undefined);
    mockCreateWebSessionStore.mockReturnValue(childStore);

    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "proj",
      sessionId: "parent-session",
      eventId: 1,
      createdAt: Date.now(),
      kind: "tool-child-session-link",
      payload: {
        type: "tool-child-session-link",
        link: {
          parentSessionId: "parent-session",
          parentToolCallId: "call-1",
          toolName: "delegate",
          childSessionId: "child-session",
          childAgentName: "explore",
          title: "Explore files",
          depth: 1,
          background: true,
          status: "running",
          createdAt: 123,
        },
      },
      agentName: "orchestrator",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "sessions"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "sessions", "root-session", "tree"] });
    expect(mockCreateWebSessionStore).toHaveBeenCalledWith("child-session", "proj");
    expect(mockInitializeFromSnapshot).toHaveBeenCalledWith({
      rootSessionId: "root-session",
      parentSessionId: "parent-session",
      agentName: "explore",
      title: "Explore files",
      createdAt: 123,
    });
  });

  test("invalidates goal and session queries on goal state change", () => {
    const state = createGoalState("goal-123", "proj", "running");
    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "proj",
      sessionId: "session-1",
      eventId: 2,
      createdAt: Date.now(),
      kind: "goal.state_change",
      payload: {
        type: "goal.state_change",
        goalId: state.id,
        status: state.status,
        state,
      },
      agentName: "orchestrator",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["goals"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", "proj", "goals"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", "proj", "goals", "goal-123"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", "proj", "sessions", "session-1"],
    });
  });

  test("invalidates HITL queues and session query on HITL resolved", () => {
    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "proj",
      sessionId: "session-1",
      eventId: 3,
      createdAt: Date.now(),
      kind: "hitl.resolved",
      payload: {
        type: "hitl.resolved",
        hitlId: "hitl-123",
        status: "resolved",
        response: { type: "permission_decision", decision: "approve_once", comment: "ok" },
      },
      agentName: "orchestrator",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["hitl", "pending"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "hitl"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", "proj", "sessions", "session-1"],
    });
  });

  test("invalidates loop queries on loop.state_change", () => {
    const loopState = createLoopState("loop-1", "active");
    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "proj",
      sessionId: "session-1",
      eventId: 10,
      createdAt: Date.now(),
      kind: "loop.state_change",
      payload: {
        type: "loop.state_change",
        loopId: "loop-1",
        status: "active",
        state: loopState,
      },
      agentName: "orchestrator",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "runs"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "budget"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "collisions"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "integrations"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["loops", "active"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "kill-state"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "sessions", "session-1"] });
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(9);
  });

  test("invalidates loop queries on loop.run_appended", () => {
    const report = {
      runId: "run-1",
      loopId: "loop-1",
      status: "succeeded" as const,
      trigger: "manual" as const,
      startedAt: 1_000,
      endedAt: 2_000,
    };
    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "proj",
      sessionId: "session-1",
      eventId: 11,
      createdAt: Date.now(),
      kind: "loop.run_appended",
      payload: {
        type: "loop.run_appended",
        loopId: "loop-1",
        report,
      },
      agentName: "orchestrator",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "runs"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "budget"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "collisions"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "integrations"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["loops", "active"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "kill-state"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "sessions", "session-1"] });
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(9);
  });

  test("invalidates loop guardrail queries on non-LoopStreamEvent payload with loopId", () => {
    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "proj",
      sessionId: "session-1",
      eventId: 12,
      createdAt: Date.now(),
      kind: "hitl.request",
      payload: {
        type: "hitl.request",
        request: {
          hitlId: "hitl-1",
          owner: { projectSlug: "proj", ownerType: "loop", ownerId: "loop-1" },
          blockingKey: "loop:loop-1:approval:run_tool",
          source: { type: "loop_approval", loopId: "loop-1", approvalPoint: "run_tool" },
          status: "pending",
          displayPayload: { title: "Approve?", redacted: true },
          createdAt: "2026-07-05T00:00:00Z",
          updatedAt: "2026-07-05T00:00:00Z",
        },
      },
      agentName: "orchestrator",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    // HITL invalidation: hitl, projectHitl, session = 3 calls
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["hitl", "pending"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "hitl"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "sessions", "session-1"] });
    // Loop guardrail invalidation: 9 calls
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "runs"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "budget"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "collisions"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "loop-1", "integrations"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["loops", "active"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "loops", "kill-state"] });
    // Total: 3 HITL + 9 loop = 12
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(12);
  });

  test("invalidates session query on reset event", () => {
    const resetEvent: GlobalSSEResetEvent = {
      type: "reset",
      slug: "my-project",
      sessionId: "session-1",
      reason: "stale_cursor",
    };

    handleSSEEvent({ event: "reset", data: JSON.stringify(resetEvent) }, deps);

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", "my-project", "sessions", "session-1"],
    });
  });

  test("refreshes MCP status snapshot on reset event", () => {
    const resetEvent: GlobalSSEResetEvent = {
      type: "reset",
      slug: "proj",
      sessionId: "s1",
      reason: "stale_cursor",
    };

    handleSSEEvent({ event: "reset", data: JSON.stringify(resetEvent) }, deps);

    expect(mockRefreshMcpStatus).toHaveBeenCalledTimes(1);
  });

  test("does not call shutdown on reset event", () => {
    const resetEvent: GlobalSSEResetEvent = {
      type: "reset",
      slug: "proj",
      sessionId: "s1",
      reason: "lagged",
    };

    handleSSEEvent({ event: "reset", data: JSON.stringify(resetEvent) }, deps);

    expect(mockOnShutdown).not.toHaveBeenCalled();
  });

  test("handles lagged event without side effects", () => {
    const laggedEvent: GlobalSSELaggedEvent = {
      type: "lagged",
      dropped: 50,
      reason: "client_backpressure",
    };

    handleSSEEvent({ event: "lagged", data: JSON.stringify(laggedEvent) }, deps);

    expect(mockOnShutdown).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
    expect(mockFindWebSessionStore).not.toHaveBeenCalled();
  });

  test("updates heartbeat timestamp on heartbeat event", () => {
    const heartbeat: GlobalSSEHeartbeatEvent = {
      type: "heartbeat",
      createdAt: 1700000000000,
    };

    handleSSEEvent({ event: "heartbeat", data: JSON.stringify(heartbeat) }, deps);

    expect(mockOnHeartbeat).toHaveBeenCalledWith(1700000000000);
  });

  test("calls onShutdown on shutdown event", () => {
    const shutdown: GlobalSSEShutdownEvent = {
      type: "shutdown",
      reason: "server_shutdown",
    };

    handleSSEEvent({ event: "shutdown", data: JSON.stringify(shutdown) }, deps);

    expect(mockOnShutdown).toHaveBeenCalled();
  });

  test("updates mcp status store on mcp_status event", () => {
    const status: McpServerStatus = { state: "ready", toolCount: 7 };
    const mcpEvent: GlobalSSEMcpStatusEvent = {
      type: "mcp_status",
      serverName: "context7",
      status,
      createdAt: 1700000000000,
    };

    handleSSEEvent({ event: "mcp_status", data: JSON.stringify(mcpEvent) }, deps);

    expect(useMcpStatusStore.getState().servers).toEqual({ context7: status });
  });

  test("mcp_status event merges into existing servers without dropping them", () => {
    useMcpStatusStore.getState().setServers({
      grep: { state: "pending" },
    });
    const status: McpServerStatus = { state: "failed", error: "timeout" };
    const mcpEvent: GlobalSSEMcpStatusEvent = {
      type: "mcp_status",
      serverName: "exa",
      status,
      createdAt: 1700000000001,
    };

    handleSSEEvent({ event: "mcp_status", data: JSON.stringify(mcpEvent) }, deps);

    expect(useMcpStatusStore.getState().servers).toEqual({
      grep: { state: "pending" },
      exa: { state: "failed", error: "timeout" },
    });
  });

  test("ignores malformed JSON in event data", () => {
    handleSSEEvent({ event: "event", data: "not-json" }, deps);

    expect(mockFindWebSessionStore).not.toHaveBeenCalled();
  });

  test("ignores unknown SSE event types with valid JSON", () => {
    handleSSEEvent({ event: "unknown-type", data: JSON.stringify({ type: "unknown" }) }, deps);

    expect(mockFindWebSessionStore).not.toHaveBeenCalled();
    expect(mockOnShutdown).not.toHaveBeenCalled();
    expect(mockOnHeartbeat).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
});

function createGoalState(goalId: string, projectId: string, status: GoalState["status"]): GoalState {
  return {
    id: goalId,
    projectId,
    title: "Ship Goal",
    status,
    phase: "build",
    doneConditions: [],
    doneResults: {},
    reviewerAgent: "reviewer",
    retryPolicy: { maxRetries: 1, backoffMs: 0, escalateOnFailure: true },
    retryCount: 0,
    approvalPoints: [],
    author: "architect",
    mainSessionId: "session-1",
    childSessionIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function createLoopState(loopId: string, status: LoopState["status"]): LoopState {
  return {
    loopId,
    projectId: "proj",
    config: {
      title: "Test Loop",
      schedule: { kind: "manual" as const },
      runKind: "session" as const,
      mode: "report" as const,
      approvalPolicy: "interactive" as const,
      limits: { maxIterationsPerRun: 10 },
    },
    status,
    createdAt: 1_000,
    updatedAt: 2_000,
    runCount: 0,
    stateVersion: 1,
  };
}
