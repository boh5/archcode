import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StoreApi } from "zustand";
import type {
  GoalState,
  GlobalSessionEventEnvelope,
  GlobalSSEHeartbeatEvent,
  GlobalSSEHitlRealtimeEvent,
  GlobalSSEMcpStatusEvent,
  GlobalSSEResetEvent,
  GlobalSSELaggedEvent,
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
  GlobalSSEShutdownEvent,
  HitlRecord,
  McpServerStatus,
} from "@archcode/protocol";
import type { WebSessionStoreState } from "../store/session-store";
import { hitlIdentityKey, hitlStore } from "../store/hitl-store";
import { useMcpStatusStore } from "../store/mcp-status-store";
import { runtimeFamilyKey, sessionRuntimeStore } from "../store/session-runtime-store";
import {
  SSE_WATCHDOG_TIMEOUT_MS,
  SSE_SHUTDOWN_RECONNECT_DELAY_MS,
  cancelSSEShutdownReconnect,
  createSSEWatchdog,
  handleSSEEvent,
  isSessionSnapshotQueryKey,
  parseSSEEvent,
  requestSSEReconnectOnce,
  requestSSEShutdownReconnectOnce,
  type SSEReconnectState,
} from "./global-sse";
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
const mockRequestReconnect = mock(() => {});
const mockRefreshSessionSnapshots = mock(() => {});

function createDeps(): SSEEventHandlerDeps {
  return {
    findStore: mockFindWebSessionStore,
    createStore: mockCreateWebSessionStore,
    invalidateQueries: mockInvalidateQueries,
    onShutdown: mockOnShutdown,
    onHeartbeat: mockOnHeartbeat,
    refreshMcpStatus: mockRefreshMcpStatus,
    requestReconnect: mockRequestReconnect,
    refreshSessionSnapshots: mockRefreshSessionSnapshots,
  };
}

describe("SSE liveness watchdog", () => {
  test("arms from connection attempt and re-arms from heartbeat with one live timer", () => {
    let nextTimerId = 1;
    const timers = new Map<number, () => void>();
    const clearedTimerIds: number[] = [];
    const onTimeout = mock(() => {});
    const watchdog = createSSEWatchdog({
      onTimeout,
      schedule: (callback, delay) => {
        expect(delay).toBe(SSE_WATCHDOG_TIMEOUT_MS);
        const timerId = nextTimerId++;
        timers.set(timerId, callback);
        return timerId;
      },
      cancel: (timerId) => {
        clearedTimerIds.push(timerId as number);
        timers.delete(timerId as number);
      },
    });

    watchdog.connectionAttemptStarted();
    const connectionTimerId = nextTimerId - 1;
    expect(timers.size).toBe(1);

    watchdog.heartbeatReceived();
    const heartbeatTimerId = nextTimerId - 1;
    expect(clearedTimerIds).toEqual([connectionTimerId]);
    expect(timers.size).toBe(1);
    expect(timers.has(heartbeatTimerId)).toBe(true);

    timers.get(heartbeatTimerId)?.();
    expect(onTimeout).toHaveBeenCalledTimes(1);

    watchdog.stop();
    expect(clearedTimerIds).toEqual([connectionTimerId]);
  });

  test("stopping clears the watchdog without firing a stale timeout", () => {
    const timers = new Map<number, () => void>();
    const onTimeout = mock(() => {});
    const watchdog = createSSEWatchdog({
      onTimeout,
      schedule: (callback) => {
        timers.set(1, callback);
        return 1;
      },
      cancel: (timerId) => timers.delete(timerId as number),
    });

    watchdog.connectionAttemptStarted();
    watchdog.stop();

    expect(timers.size).toBe(0);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test("reconnect gate invalidates readiness first and coalesces duplicates", () => {
    const state = { requested: false, shutdown: false };
    const order: string[] = [];
    const actions = {
      invalidateReadiness: () => order.push("invalidate"),
      markReconnecting: () => order.push("state"),
      abortConnection: () => order.push("abort"),
      scheduleReconnect: () => order.push("reconnect"),
    };

    expect(requestSSEReconnectOnce(state, actions)).toBe(true);
    expect(requestSSEReconnectOnce(state, actions)).toBe(false);
    expect(order).toEqual(["invalidate", "state", "abort", "reconnect"]);

    state.requested = false;
    state.shutdown = true;
    expect(requestSSEReconnectOnce(state, actions)).toBe(false);
    expect(order).toEqual(["invalidate", "state", "abort", "reconnect"]);
  });

  test("graceful shutdown schedules one delayed reconnect and can be cancelled", () => {
    const state: SSEReconnectState = { requested: false, shutdown: false };
    const order: string[] = [];
    let scheduled: (() => void) | undefined;
    const actions = {
      markClosed: () => order.push("closed"),
      stopWatchdog: () => order.push("watchdog"),
      abortConnection: () => order.push("abort"),
      markReconnecting: () => order.push("reconnecting"),
      scheduleReconnect: () => order.push("reconnect"),
      schedule: (callback: () => void, delay: number) => {
        expect(delay).toBe(SSE_SHUTDOWN_RECONNECT_DELAY_MS);
        scheduled = callback;
        return 7;
      },
      cancel: (timer: unknown) => order.push(`cancel:${String(timer)}`),
    };

    expect(requestSSEShutdownReconnectOnce(state, actions)).toBe(true);
    expect(requestSSEShutdownReconnectOnce(state, actions)).toBe(false);
    expect(order).toEqual(["closed", "watchdog", "abort"]);
    expect(state.shutdown).toBe(true);

    scheduled?.();
    expect(state).toMatchObject({ requested: false, shutdown: false, shutdownTimer: undefined });
    expect(order).toEqual(["closed", "watchdog", "abort", "reconnecting", "reconnect"]);

    expect(requestSSEShutdownReconnectOnce(state, actions)).toBe(true);
    cancelSSEShutdownReconnect(state, actions.cancel);
    expect(order.at(-1)).toBe("cancel:7");
    expect(state.shutdown).toBe(true);
  });

  test("matches only project Session snapshot query keys", () => {
    expect(isSessionSnapshotQueryKey(["projects", "demo", "sessions"])).toBe(true);
    expect(isSessionSnapshotQueryKey(["projects", "demo", "sessions", "root-1"])).toBe(true);
    expect(isSessionSnapshotQueryKey(["projects", "demo", "sessions", "child-1", "focused"])).toBe(true);
    expect(isSessionSnapshotQueryKey(["projects", "demo", "goals", "goal-1"])).toBe(false);
    expect(isSessionSnapshotQueryKey(["sessions", "root-1"])).toBe(false);
  });
});

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

  test("parses hitl.event with full projection", () => {
    const event = hitlRealtimeEvent({
      projectSlug: "proj",
      hitlId: "hitl-1",
    });

    const result = parseSSEEvent("hitl.event", JSON.stringify(event));

    expect(result).toEqual(event);
  });

  test("parses authoritative hitl.snapshot reset events", () => {
    const projection = hitlRealtimeEvent({ projectSlug: "proj", hitlId: "hitl-1" }).projection;
    const event = {
      type: "hitl.snapshot" as const,
      projectSlugs: ["proj"],
      projections: [projection],
      createdAt: 1700000000000,
    };

    const result = parseSSEEvent("hitl.snapshot", JSON.stringify(event));

    expect(result).toEqual(event);
  });

  test("parses session runtime snapshot and change events", () => {
    const snapshot: GlobalSSESessionRuntimeSnapshotEvent = {
      type: "session.runtime.snapshot",
      projectSlugs: ["proj"],
      families: [{ projectSlug: "proj", rootSessionId: "root-1", activity: "running" }],
      createdAt: 1,
    };
    const changed: GlobalSSESessionRuntimeChangedEvent = {
      type: "session.runtime_changed",
      projectSlug: "proj",
      rootSessionId: "root-1",
      activity: "stopping",
      createdAt: 2,
    };

    expect(parseSSEEvent(snapshot.type, JSON.stringify(snapshot))).toEqual(snapshot);
    expect(parseSSEEvent(changed.type, JSON.stringify(changed))).toEqual(changed);
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
    mockRequestReconnect.mockClear();
    mockRefreshSessionSnapshots.mockClear();
    hitlStore.getState().reset();
    sessionRuntimeStore.getState().reset();
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
      agentName: "engineer",
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
      agentName: "engineer",
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
      agentName: "engineer",
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
      agentName: "engineer",
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

  test("session-local HITL events only invalidate the owning session query", () => {
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
      agentName: "engineer",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", "proj", "sessions", "session-1"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
  });

  test("stores full hitl.event projection and invalidates related session query", () => {
    const event = hitlRealtimeEvent({
      projectSlug: "proj",
      hitlId: "hitl-1",
    });

    handleSSEEvent({ event: "hitl.event", data: JSON.stringify(event) }, deps);

    expect(hitlStore.getState().projections[hitlIdentityKey(event.projection)]).toEqual(event.projection);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "sessions", "session-1"] });
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
  });

  test("atomically applies the authoritative hitl.snapshot and marks projects initialized", () => {
    const stale = hitlRealtimeEvent({ projectSlug: "proj", hitlId: "stale" });
    hitlStore.getState().applyRealtimeEvent(stale);
    const fresh = hitlRealtimeEvent({ projectSlug: "proj", hitlId: "fresh" });

    handleSSEEvent({
      event: "hitl.snapshot",
      data: JSON.stringify({
        type: "hitl.snapshot",
        projectSlugs: ["proj"],
        projections: [fresh.projection],
        createdAt: 1700000000001,
      }),
    }, deps);

    expect(hitlStore.getState().projections[hitlIdentityKey(stale.projection)]).toBeUndefined();
    expect(hitlStore.getState().projections[hitlIdentityKey(fresh.projection)]).toEqual(fresh.projection);
    expect(hitlStore.getState().isProjectInitialized("proj")).toBe(true);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj"], exact: false });
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

  test("lagged event requests reconnect and an authoritative Session snapshot refresh", () => {
    const laggedEvent: GlobalSSELaggedEvent = {
      type: "lagged",
      dropped: 50,
      reason: "client_backpressure",
    };

    handleSSEEvent({ event: "lagged", data: JSON.stringify(laggedEvent) }, deps);

    expect(mockOnShutdown).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
    expect(mockFindWebSessionStore).not.toHaveBeenCalled();
    expect(mockRequestReconnect).toHaveBeenCalledTimes(1);
    expect(mockRefreshSessionSnapshots).toHaveBeenCalledTimes(1);
  });

  test("runtime snapshot authoritatively clears stale running families", () => {
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["proj"],
      families: [{ projectSlug: "proj", rootSessionId: "stale-root", activity: "running" }],
      createdAt: 1,
    });
    const snapshot: GlobalSSESessionRuntimeSnapshotEvent = {
      type: "session.runtime.snapshot",
      projectSlugs: ["proj"],
      families: [{ projectSlug: "proj", rootSessionId: "current-root", activity: "stopping" }],
      createdAt: 2,
    };

    handleSSEEvent({ event: snapshot.type, data: JSON.stringify(snapshot) }, deps);

    expect(sessionRuntimeStore.getState().families).toEqual({
      [runtimeFamilyKey("proj", "current-root")]: snapshot.families[0],
    });
    expect(sessionRuntimeStore.getState().isProjectInitialized("proj")).toBe(true);
    expect(mockRefreshSessionSnapshots).toHaveBeenCalledTimes(1);
  });

  test("runtime change upserts non-idle and removes idle activity", () => {
    const snapshot: GlobalSSESessionRuntimeSnapshotEvent = {
      type: "session.runtime.snapshot",
      projectSlugs: ["proj"],
      families: [],
      createdAt: 1,
    };
    handleSSEEvent({ event: snapshot.type, data: JSON.stringify(snapshot) }, deps);

    const running: GlobalSSESessionRuntimeChangedEvent = {
      type: "session.runtime_changed",
      projectSlug: "proj",
      rootSessionId: "root-1",
      activity: "running",
      createdAt: 2,
    };
    handleSSEEvent({ event: running.type, data: JSON.stringify(running) }, deps);
    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBe("running");

    const idle: GlobalSSESessionRuntimeChangedEvent = { ...running, activity: "idle", createdAt: 3 };
    handleSSEEvent({ event: idle.type, data: JSON.stringify(idle) }, deps);
    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBe("idle");
  });

  test("lagged invalidates runtime and HITL readiness before forcing reconnect", () => {
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["proj"],
      families: [{ projectSlug: "proj", rootSessionId: "root-1", activity: "running" }],
      createdAt: 1,
    });
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["proj"],
      projections: [],
      createdAt: 1,
    });
    const laggedEvent: GlobalSSELaggedEvent = {
      type: "lagged",
      dropped: 1,
      reason: "client_backpressure",
    };

    handleSSEEvent({ event: "lagged", data: JSON.stringify(laggedEvent) }, deps);

    expect(sessionRuntimeStore.getState().activityFor("proj", "root-1")).toBeUndefined();
    expect(hitlStore.getState().isProjectInitialized("proj")).toBe(false);
    expect(mockRequestReconnect).toHaveBeenCalledTimes(1);
    expect(mockRefreshSessionSnapshots).toHaveBeenCalledTimes(1);
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
    expect(mockRefreshSessionSnapshots).toHaveBeenCalledTimes(1);
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
    version: 4,
    id: goalId,
    projectId,
    createdFromSessionId: "origin",
    title: "Ship Goal",
    objective: "Simplify the Goal experience",
    acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
    useWorktree: false,
    status,
    attempt: 1,
    reviewGeneration: 0,
    pendingHitlIds: [],
    approvalRefs: [],
    appliedHitlIds: [],
    mainSessionId: "session-1",
    childSessionIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    startedAt: "2026-07-01T00:00:00.000Z",
  };
}

function hitlRealtimeEvent(input: {
  projectSlug: string;
  hitlId: string;
  owner?: GlobalSSEHitlRealtimeEvent["owner"];
  source?: GlobalSSEHitlRealtimeEvent["projection"]["source"];
  ancestry?: GlobalSSEHitlRealtimeEvent["projection"]["ancestry"];
  status?: GlobalSSEHitlRealtimeEvent["projection"]["status"];
  payloadType?: "hitl.request" | "hitl.resolved";
}): GlobalSSEHitlRealtimeEvent {
  const owner = input.owner ?? { projectSlug: input.projectSlug, ownerType: "session", ownerId: "session-1" };
  const source = input.source ?? { type: "ask_user", sessionId: "session-1", toolCallId: "call-1" };
  const status = input.status ?? "pending";
  const record: HitlRecord = {
    hitlId: input.hitlId,
    owner,
    blockingKey: `${owner.ownerType}:${owner.ownerId}:hitl:${input.hitlId}`,
    source,
    status,
    displayPayload: {
      title: "Need input",
      questions: [{ header: "Q1", question: "Continue?", options: [], custom: true }],
      redacted: true,
    },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
  const projection: GlobalSSEHitlRealtimeEvent["projection"] = {
    hitlId: record.hitlId,
    project: { slug: input.projectSlug },
    owner: record.owner,
    ...(input.ancestry === undefined ? {} : { ancestry: input.ancestry }),
    source: record.source,
    status,
    displayPayload: record.displayPayload,
    allowedActions: status === "pending" ? ["answer", "cancel"] : [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return {
    type: "hitl.event",
    projectSlug: input.projectSlug,
    owner,
    hitlId: input.hitlId,
    createdAt: 1700000000000,
    payload: input.payloadType === "hitl.resolved"
      ? { type: "hitl.resolved", status: "resolved" }
      : { type: "hitl.request", status: "pending" },
    projection,
  };
}
