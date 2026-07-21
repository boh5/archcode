import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import type { StoreApi } from "zustand";
import type {
  GlobalSessionEventEnvelope,
  GlobalSSEHeartbeatEvent,
  GlobalSSEHitlRealtimeEvent,
  GlobalSSEMcpStatusEvent,
  GlobalSSEModelRuntimeChangedEvent,
  GlobalSSEResetEvent,
  GlobalSSELaggedEvent,
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
  GlobalSSEShutdownEvent,
  HitlView,
  McpServerStatus,
  SessionGoal,
} from "@archcode/protocol";
import type { WebSessionStoreState } from "../store/session-store";
import { queryKeys } from "../api/queries";
import { hitlStore, scopedHitlIdentity, scopedHitlKey, type ScopedHitlView } from "../store/hitl-store";
import { useMcpStatusStore } from "../store/mcp-status-store";
import { runtimeFamilyKey, sessionRuntimeStore } from "../store/session-runtime-store";
import {
  SSE_WATCHDOG_TIMEOUT_MS,
  SSE_SHUTDOWN_RECONNECT_DELAY_MS,
  cancelSSEShutdownReconnect,
  createHitlNotificationGate,
  createSSEWatchdog,
  handleSSEEvent,
  isHitlOwnerForeground,
  isProjectTodoQueryKey,
  isSessionSnapshotQueryKey,
  parseSSEEvent,
  refreshProjectTodoQueriesAfterSSEOpen,
  resolveHitlNoticeEntries,
  requestSSEReconnectOnce,
  requestSSEShutdownReconnectOnce,
  showHiddenBrowserHitlNotification,
  type SSEReconnectState,
} from "./global-sse";

const binding = { selection: { model: "test:model" }, providerId: "test", modelId: "model", providerDisplayName: "Test", modelDisplayName: "Test Model", resolution: "profile_default" as const, modelRuntimeRevision: "m1" };
const sessionGoal: SessionGoal = {
  instanceId: "00000000-0000-4000-8000-000000000001",
  generation: 1,
  objective: "Finish the implementation",
  status: "active",
  usage: { tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }, executionTimeMs: 0, executionCount: 0 },
  createdAt: 1,
  activatedAt: 1,
  updatedAt: 1,
};
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

  test("selects and actively refreshes only project Todo list and detail queries after SSE opens", async () => {
    const candidates = [
      ["projects", "demo", "todos"],
      ["projects", "demo", "todos", "todo-1"],
      ["projects", "other", "todos"],
      ["projects", "demo", "sessions"],
      ["projects", "demo", "goals", "goal-1"],
      ["projects", "demo", "todos", "todo-1", "history"],
      ["todos", "demo"],
    ] as const;
    const refreshed: (readonly unknown[])[] = [];
    const invalidateQueries = mock(async (filters: {
      predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
      refetchType?: string;
    }) => {
      expect(filters.refetchType).toBe("active");
      for (const queryKey of candidates) {
        if (filters.predicate?.({ queryKey })) refreshed.push(queryKey);
      }
    });

    await refreshProjectTodoQueriesAfterSSEOpen({
      invalidateQueries,
    } as unknown as Pick<QueryClient, "invalidateQueries">);

    expect(refreshed).toEqual([
      ["projects", "demo", "todos"],
      ["projects", "demo", "todos", "todo-1"],
      ["projects", "other", "todos"],
    ]);
    expect(isProjectTodoQueryKey(["projects", 1, "todos"])).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
  });
});

describe("parseSSEEvent", () => {
  test("parses valid event type", () => {
    const data = JSON.stringify({ type: "event", slug: "p", sessionId: "s", eventId: 1, createdAt: 0, payload: { type: "text-start" }, agentName: "lead" });
    const result = parseSSEEvent("event", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("event");
  });

  test("parses the current llm-retry payload including nextRetryAt", () => {
    const data = JSON.stringify({
      type: "event",
      slug: "p",
      sessionId: "s",
      eventId: 1,
      createdAt: 0,
      payload: {
        type: "llm-retry",
        scope: "session",
        visibility: "session",
        attempt: 1,
        errorKind: "network",
        message: "Retrying",
        nextRetryAt: 123,
      },
      agentName: "lead",
    });

    expect(parseSSEEvent("event", data)).not.toBeNull();
  });

  test("rejects session envelopes without a valid payload type", () => {
    const missingType = JSON.stringify({
      type: "event",
      slug: "p",
      sessionId: "s",
      eventId: 1,
      createdAt: 0,
      payload: {},
      agentName: "lead",
    });
    const removedKind = JSON.stringify({
      type: "event",
      slug: "p",
      sessionId: "s",
      eventId: 1,
      createdAt: 0,
      kind: "text-start",
      payload: { type: "text-start" },
      agentName: "lead",
    });

    expect(parseSSEEvent("event", missingType)).toBeNull();
    expect(parseSSEEvent("event", removedKind)).toBeNull();
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
    const status: McpServerStatus = { state: "ready", toolCount: 4, warningCount: 0 };
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

  test("parses model runtime invalidation events", () => {
    const event: GlobalSSEModelRuntimeChangedEvent = {
      type: "model_runtime.changed",
      revision: "revision-2",
      createdAt: 1700000000002,
    };

    expect(parseSSEEvent(event.type, JSON.stringify(event))).toEqual(event);
  });

  test("parses hitl.event with its canonical view", () => {
    const event = hitlRealtimeEvent({
      projectSlug: "proj",
      hitlId: "hitl-1",
    });

    const result = parseSSEEvent("hitl.event", JSON.stringify(event));

    expect(result).toEqual(event);
  });

  test("rejects removed and malformed global event contracts", () => {
    const hitlEvent = hitlRealtimeEvent({ projectSlug: "proj", hitlId: "hitl-1" });
    const resourceEvent = {
      type: "resource.changed",
      projectSlug: "proj",
      resourceType: "goal",
      resourceId: "goal-1",
      createdAt: 1,
    };

    expect(parseSSEEvent("hitl.event", JSON.stringify({
      ...hitlEvent,
      payload: { ...hitlEvent.payload, status: "pending" },
    }))).toBeNull();
    expect(parseSSEEvent("hitl.event", JSON.stringify({ type: "hitl.event" }))).toBeNull();
    expect(parseSSEEvent("resource.changed", JSON.stringify({
      ...resourceEvent,
      reason: "created",
    }))).toBeNull();
    expect(parseSSEEvent("resource.changed", JSON.stringify({ type: "resource.changed" }))).toBeNull();
  });

  test("parses authoritative hitl.snapshot reset events", () => {
    const view = hitlRealtimeEvent({ projectSlug: "proj", hitlId: "hitl-1" }).view;
    const event = {
      type: "hitl.snapshot" as const,
      projectSlugs: ["proj"],
      entries: [hitlSnapshotEntry(hitlRealtimeEvent({ projectSlug: "proj", hitlId: "hitl-1" }))],
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
    const result = parseSSEEvent("unknown-type", JSON.stringify({ type: "event", slug: "p", sessionId: "s", eventId: 1, createdAt: 0, payload: { type: "text-start" }, agentName: "lead" }));
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
      payload: { type: "text-start" },
      agentName: "lead",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockFindWebSessionStore).toHaveBeenCalledWith("session-1", "my-project");
    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
  });

  test("keeps Session Goal projections live and invalidates all Goal consumers", () => {
    const store = createMockStore();
    mockFindWebSessionStore.mockReturnValue(store);
    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "my-project",
      sessionId: "session-1",
      eventId: 42,
      createdAt: 1,
      agentName: "lead",
      payload: {
        type: "session.goal_changed",
        action: "usage_recorded",
        instanceId: sessionGoal.instanceId,
        generation: sessionGoal.generation,
        goal: sessionGoal,
        status: sessionGoal.status,
        occurredAt: 1,
      },
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
    expect(mockInvalidateQueries.mock.calls.map(([options]) => options.queryKey)).toEqual([
      queryKeys.session("my-project", "session-1"),
      queryKeys.sessions("my-project"),
      queryKeys.dashboardProjection({ kind: "global" }),
      queryKeys.dashboardProjection({ kind: "project", projectSlug: "my-project" }),
    ]);
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
      payload: { type: "text-start" },
      agentName: "lead",
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockFindWebSessionStore).toHaveBeenCalledWith("unknown-session", "my-project");
    expect(mockCreateWebSessionStore).toHaveBeenCalledWith("unknown-session", "my-project");
    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
  });

  test("waits for execution-start before refreshing Session topology after a Todo checkpoint", () => {
    const store = createMockStore();
    mockFindWebSessionStore.mockReturnValue(store);

    handleSSEEvent({ event: "resource.changed", data: JSON.stringify({
      type: "resource.changed",
      projectSlug: "proj",
      resourceType: "todo",
      resourceId: "todo-1",
      createdAt: 1,
    }) }, deps);

    expect(mockInvalidateQueries.mock.calls.map(([options]) => options.queryKey)).toEqual([
      queryKeys.projectTodos("proj"),
      queryKeys.projectTodo("proj", "todo-1"),
    ]);
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({ queryKey: queryKeys.sessions("proj") });

    const executionStart: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "proj",
      sessionId: "source-session",
      eventId: 1,
      createdAt: 2,
      payload: { type: "execution-start", executionId: "project-todo:todo-1:activation", binding, origin: "user_message" },
      agentName: "lead",
    };
    handleSSEEvent({ event: "event", data: JSON.stringify(executionStart) }, deps);

    expect(mockInvalidateQueries.mock.calls.map(([options]) => options.queryKey)).toEqual([
      queryKeys.projectTodos("proj"),
      queryKeys.projectTodo("proj", "todo-1"),
      queryKeys.session("proj", "source-session"),
      queryKeys.sessions("proj"),
    ]);
    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(executionStart);
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
      payload: {
        type: "tool-child-session-link",
        link: {
          parentSessionId: "parent-session",
          parentToolCallId: "call-1",
          toolName: "delegate",
          childSessionId: "child-session",
          childAgentName: "explore", childProfile: "fast", childSkillNames: [],
          title: "Explore files",
          depth: 1,
          background: true,
          status: "running",
          createdAt: 123,
        },
      },
      agentName: "lead",
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

  test("session-local HITL stream events are no longer accepted", () => {
    expect(parseSSEEvent("event", JSON.stringify({ type: "event", payload: { type: "hitl.resolved" } }))).toBeNull();
  });

  test("stores the scoped hitl.event view without touching query caches", () => {
    const event = hitlRealtimeEvent({
      projectSlug: "proj",
      hitlId: "hitl-1",
    });

    handleSSEEvent({ event: "hitl.event", data: JSON.stringify(event) }, deps);

    expect(hitlStore.getState().views[scopedHitlKey(event)]).toEqual({ projectSlug: "proj", ownerSessionId: event.ownerSessionId, rootSessionId: event.rootSessionId, view: event.view });
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
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
        entries: [hitlSnapshotEntry(fresh)],
        createdAt: 1700000000001,
      }),
    }, deps);

    expect(hitlStore.getState().views[scopedHitlKey(stale)]).toBeUndefined();
    expect(hitlStore.getState().views[scopedHitlKey(fresh)]).toEqual({ projectSlug: "proj", ownerSessionId: fresh.ownerSessionId, rootSessionId: fresh.rootSessionId, view: fresh.view });
    expect(hitlStore.getState().isProjectInitialized("proj")).toBe(true);
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
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
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.dashboardProjection({ kind: "global" }) });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.dashboardProjection({ kind: "project", projectSlug: "my-project" }) });
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
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
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
      entries: [],
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
    const status: McpServerStatus = { state: "ready", toolCount: 7, warningCount: 1 };
    const mcpEvent: GlobalSSEMcpStatusEvent = {
      type: "mcp_status",
      serverName: "context7",
      status,
      createdAt: 1700000000000,
    };

    handleSSEEvent({ event: "mcp_status", data: JSON.stringify(mcpEvent) }, deps);

    expect(useMcpStatusStore.getState().servers).toEqual({ context7: status });
  });

  test("invalidates the secret-free model runtime query on publish", () => {
    const event: GlobalSSEModelRuntimeChangedEvent = {
      type: "model_runtime.changed",
      revision: "revision-2",
      createdAt: 1700000000002,
    };

    handleSSEEvent({ event: event.type, data: JSON.stringify(event) }, deps);

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.modelRuntime });
    expect(mockRefreshSessionSnapshots).toHaveBeenCalledTimes(1);
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

describe("HITL live notification gate", () => {
  test("uses the snapshot as a baseline and emits only one new live request", () => {
    const gate = createHitlNotificationGate();
    const existing = hitlRealtimeEvent({ projectSlug: "proj", hitlId: "existing" });
    const live = hitlRealtimeEvent({ projectSlug: "proj", hitlId: "live" });

    gate.beginConnection();
    gate.observeSnapshot({ type: "hitl.snapshot", projectSlugs: ["proj"], entries: [hitlSnapshotEntry(existing)], createdAt: 1 });

    expect(gate.observeRealtimeEvent(existing)).toBeNull();
    expect(gate.observeRealtimeEvent(live)).toEqual({
      projectSlug: "proj",
      ownerSessionId: live.ownerSessionId,
      rootSessionId: live.rootSessionId,
      view: live.view,
    });
    expect(gate.observeRealtimeEvent(live)).toBeNull();
    expect(gate.observeRealtimeEvent({ ...live, payload: { type: "hitl.updated" } })).toBeNull();
  });
});

describe("HITL live notification presentation", () => {
  const foregroundEnvironment = (search: string) => ({
    visibilityState: "visible" as const,
    hasFocus: true,
    pathname: "/projects/proj/sessions/root-session",
    search,
  });

  test("treats exactly one root or focused child owner as foreground", () => {
    const root = scopedHitlView("root-session");
    const childA = scopedHitlView("child-a");
    const childB = scopedHitlView("child-b");

    expect([
      isHitlOwnerForeground(root, foregroundEnvironment("")),
      isHitlOwnerForeground(childA, foregroundEnvironment("")),
      isHitlOwnerForeground(childB, foregroundEnvironment("")),
    ]).toEqual([true, false, false]);
    expect([
      isHitlOwnerForeground(root, foregroundEnvironment("?focus=child-a")),
      isHitlOwnerForeground(childA, foregroundEnvironment("?focus=child-a")),
      isHitlOwnerForeground(childB, foregroundEnvironment("?focus=child-a")),
    ]).toEqual([false, true, false]);
    expect([
      isHitlOwnerForeground(root, foregroundEnvironment("?focus=child-b")),
      isHitlOwnerForeground(childA, foregroundEnvironment("?focus=child-b")),
      isHitlOwnerForeground(childB, foregroundEnvironment("?focus=child-b")),
    ]).toEqual([false, false, true]);
  });

  test("does not suppress announcements for a hidden, unfocused, or different Session page", () => {
    const root = scopedHitlView("root-session");
    expect(isHitlOwnerForeground(root, { ...foregroundEnvironment(""), visibilityState: "hidden" })).toBe(false);
    expect(isHitlOwnerForeground(root, { ...foregroundEnvironment(""), hasFocus: false })).toBe(false);
    expect(isHitlOwnerForeground(root, { ...foregroundEnvironment(""), pathname: "/projects/proj/sessions/other" })).toBe(false);
  });

  test("opens the precise HITL deep link from a granted hidden-page browser notification", () => {
    const entry = scopedHitlView("child-a");
    let onClick: (() => void) | undefined;
    const createNotification = mock((title: string, body: string, handler: () => void) => {
      expect(title).toBe("ArchCode needs your attention");
      expect(body).toBe("Need input");
      onClick = handler;
    });
    const focusWindow = mock(() => {});
    const navigate = mock((_path: string) => {});

    expect(showHiddenBrowserHitlNotification(entry, {
      visibilityState: "hidden",
      permission: "granted",
      createNotification,
      focusWindow,
      navigate,
    })).toBe(true);
    onClick?.();

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/projects/proj/sessions/root-session?hitl=hitl-child-a&focus=child-a");
  });

  test("does not create a browser notification when permission is denied", () => {
    const createNotification = mock((_title: string, _body: string, _onClick: () => void) => {});
    expect(showHiddenBrowserHitlNotification(scopedHitlView("root-session"), {
      visibilityState: "hidden",
      permission: "denied",
      createNotification,
      focusWindow: () => {},
      navigate: () => {},
    })).toBe(false);
    expect(createNotification).not.toHaveBeenCalled();
  });

  test("dereferences toast identities from the authoritative store and drops resolved HITL immediately", () => {
    hitlStore.getState().reset();
    const request = hitlRealtimeEvent({ projectSlug: "proj", hitlId: "live" });
    hitlStore.getState().applyRealtimeEvent(request);
    const identity = scopedHitlIdentity(scopedHitlView("session-1", "live"));

    expect(resolveHitlNoticeEntries([identity], hitlStore.getState().views)).toHaveLength(1);

    hitlStore.getState().applyRealtimeEvent({
      ...request,
      payload: { type: "hitl.resolved" },
      view: { ...request.view, status: "resolved", allowedActions: [] },
    });

    expect(resolveHitlNoticeEntries([identity], hitlStore.getState().views)).toEqual([]);
  });
});

function hitlSnapshotEntry(event: GlobalSSEHitlRealtimeEvent) {
  return {
    projectSlug: event.projectSlug,
    hitlId: event.hitlId,
    ownerSessionId: event.ownerSessionId,
    rootSessionId: event.rootSessionId,
    view: event.view,
  };
}

function hitlRealtimeEvent(input: { projectSlug: string; hitlId: string; status?: HitlView["status"] }): GlobalSSEHitlRealtimeEvent {
  const status = input.status ?? "pending";
  const view: HitlView = {
    hitlId: input.hitlId,
    owner: { type: "session", id: "session-1" },
    source: { type: "ask_user", toolCallId: "call-1" },
    status,
    displayPayload: { title: "Need input", redacted: true },
    allowedActions: status === "pending" ? ["answer", "cancel"] : [],
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
  return { type: "hitl.event", projectSlug: input.projectSlug, hitlId: input.hitlId, ownerSessionId: view.owner.id, rootSessionId: "root-session", createdAt: 1700000000000, payload: { type: "hitl.request" }, view };
}

function scopedHitlView(ownerSessionId: string, hitlId = `hitl-${ownerSessionId}`): ScopedHitlView {
  return {
    projectSlug: "proj",
    ownerSessionId,
    rootSessionId: "root-session",
    view: {
      hitlId,
      owner: { type: "session", id: ownerSessionId },
      source: { type: "ask_user", toolCallId: "call-1" },
      status: "pending",
      displayPayload: { title: "Need input", redacted: true },
      allowedActions: ["answer", "cancel"],
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    },
  };
}
