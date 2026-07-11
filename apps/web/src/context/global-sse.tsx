import { createContext, useContext, useEffect, useRef, useState, useCallback, createElement, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectSSE } from "../lib/sse-client";
import { createWebSessionStore, findWebSessionStore } from "../store/session-store";
import { hitlStore } from "../store/hitl-store";
import { useMcpStatusStore } from "../store/mcp-status-store";
import { sessionRuntimeStore } from "../store/session-runtime-store";
import { invalidateControlPlaneReadiness } from "../store/control-plane-readiness";
import { getMcpStatus } from "../api/mcp";
import { queryKeys } from "../api/queries";
import type {
  GlobalSSEEvent,
  GlobalSessionEventEnvelope,
  GlobalSSEHeartbeatEvent,
  GlobalSSEHitlRealtimeEvent,
  GlobalSSEHitlSnapshotEvent,
  GlobalSSEMcpStatusEvent,
  GlobalSSEResetEvent,
  GlobalSSEResourceChangedEvent,
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
  SessionEventPayload,
} from "@archcode/protocol";

export type GlobalSSEConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface GlobalSSEContextValue {
  connectionState: GlobalSSEConnectionState;
  lastError: Error | null;
  lastHeartbeatAt: number;
}

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_WATCHDOG_TIMEOUT_MS = SSE_HEARTBEAT_INTERVAL_MS * 3;
export const SSE_SHUTDOWN_RECONNECT_DELAY_MS = 1_000;

interface SSEWatchdogOptions {
  onTimeout: () => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

export interface SSEWatchdog {
  connectionAttemptStarted: () => void;
  connectionOpened: () => void;
  heartbeatReceived: () => void;
  stop: () => void;
}

export function createSSEWatchdog(options: SSEWatchdogOptions): SSEWatchdog {
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;

  const stop = () => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };

  const arm = () => {
    stop();
    timer = schedule(() => {
      timer = undefined;
      options.onTimeout();
    }, SSE_WATCHDOG_TIMEOUT_MS);
  };

  return {
    connectionAttemptStarted: arm,
    connectionOpened: arm,
    heartbeatReceived: arm,
    stop,
  };
}

export interface SSEReconnectState {
  requested: boolean;
  shutdown: boolean;
  shutdownTimer?: unknown;
}

interface SSEReconnectActions {
  invalidateReadiness: () => void;
  markReconnecting: () => void;
  abortConnection: () => void;
  scheduleReconnect: () => void;
}

export function requestSSEReconnectOnce(
  state: SSEReconnectState,
  actions: SSEReconnectActions,
): boolean {
  if (state.shutdown || state.requested) return false;

  state.requested = true;
  actions.invalidateReadiness();
  actions.markReconnecting();
  actions.abortConnection();
  actions.scheduleReconnect();
  return true;
}

interface SSEShutdownReconnectActions {
  markClosed: () => void;
  stopWatchdog: () => void;
  abortConnection: () => void;
  markReconnecting: () => void;
  scheduleReconnect: () => void;
  schedule?: (callback: () => void, delay: number) => unknown;
}

export function requestSSEShutdownReconnectOnce(
  state: SSEReconnectState,
  actions: SSEShutdownReconnectActions,
): boolean {
  if (state.shutdownTimer !== undefined) return false;

  state.shutdown = true;
  state.requested = true;
  actions.markClosed();
  actions.stopWatchdog();
  actions.abortConnection();

  const schedule = actions.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  state.shutdownTimer = schedule(() => {
    state.shutdownTimer = undefined;
    state.shutdown = false;
    state.requested = false;
    actions.markReconnecting();
    actions.scheduleReconnect();
  }, SSE_SHUTDOWN_RECONNECT_DELAY_MS);
  return true;
}

export function cancelSSEShutdownReconnect(
  state: SSEReconnectState,
  cancel: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
): void {
  if (state.shutdownTimer === undefined) return;
  cancel(state.shutdownTimer);
  state.shutdownTimer = undefined;
}

export function isSessionSnapshotQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === "projects"
    && typeof queryKey[1] === "string"
    && queryKey[2] === "sessions";
}

const GlobalSSEContext = createContext<GlobalSSEContextValue | null>(null);

export function parseSSEEvent(_event: string, data: string): GlobalSSEEvent | null {
  try {
    const parsed = JSON.parse(data) as GlobalSSEEvent;
    switch (parsed.type) {
      case "event":
      case "heartbeat":
      case "reset":
      case "lagged":
      case "shutdown":
      case "mcp_status":
      case "hitl.snapshot":
      case "hitl.event":
      case "resource.changed":
      case "session.runtime.snapshot":
      case "session.runtime_changed":
        return parsed;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export interface SSEEventHandlerDeps {
  findStore: typeof findWebSessionStore;
  createStore: typeof createWebSessionStore;
  invalidateQueries: (opts: { queryKey: readonly unknown[]; exact?: boolean }) => Promise<void>;
  onShutdown: () => void;
  onHeartbeat: (createdAt: number) => void;
  refreshMcpStatus: () => void;
  requestReconnect: () => void;
  refreshSessionSnapshots: () => void;
}

export function handleSSEEvent(
  sseEvent: { event: string; data: string; id?: string },
  deps: SSEEventHandlerDeps,
): void {
  const parsed = parseSSEEvent(sseEvent.event, sseEvent.data);
  if (!parsed) return;

  switch (parsed.type) {
    case "event": {
      const envelope = parsed as GlobalSessionEventEnvelope;
      const store = deps.findStore(envelope.sessionId, envelope.slug)
        ?? deps.createStore(envelope.sessionId, envelope.slug);
      store.getState().applyRemoteEnvelope(envelope);

      if (envelope.payload.type === "tool-child-session-link") {
        const { link } = envelope.payload;
        deps.invalidateQueries({ queryKey: queryKeys.sessions(envelope.slug) });
        deps.invalidateQueries({ queryKey: queryKeys.tree(envelope.slug, store.getState().rootSessionId) });
        const childStore = deps.findStore(link.childSessionId, envelope.slug)
          ?? deps.createStore(link.childSessionId, envelope.slug);
        childStore.getState().initializeFromSnapshot({
          rootSessionId: store.getState().rootSessionId,
          parentSessionId: link.parentSessionId,
          agentName: link.childAgentName,
          title: link.title ?? link.description ?? null,
          createdAt: link.createdAt,
        });
      }

      if (isGoalPayload(envelope.payload)) {
        deps.invalidateQueries({ queryKey: queryKeys.goals });
        deps.invalidateQueries({ queryKey: queryKeys.projectGoals(envelope.slug) });
        deps.invalidateQueries({
          queryKey: queryKeys.goal(envelope.slug, envelope.payload.goalId),
        });
        deps.invalidateQueries({
          queryKey: queryKeys.session(envelope.slug, envelope.sessionId),
        });
      }

      if (isHitlPayload(envelope.payload)) {
        deps.invalidateQueries({
          queryKey: queryKeys.session(envelope.slug, envelope.sessionId),
        });
      }

      if (envelope.payload.type === "execution-start") {
        deps.invalidateQueries({
          queryKey: queryKeys.session(envelope.slug, envelope.sessionId),
        });
      }

      if (isLoopPayload(envelope.payload)) {
        invalidateLoopGuardrailQueries(deps, envelope.slug, envelope.payload.loopId, envelope.sessionId);
      } else {
        const loopId = extractLoopIdFromPayload(envelope.payload);
        if (loopId) {
          invalidateLoopGuardrailQueries(deps, envelope.slug, loopId, envelope.sessionId);
        }
      }
      break;
    }
    case "heartbeat": {
      const hb = parsed as GlobalSSEHeartbeatEvent;
      deps.onHeartbeat(hb.createdAt);
      break;
    }
    case "reset": {
      const reset = parsed as GlobalSSEResetEvent;
      deps.invalidateQueries({ queryKey: queryKeys.session(reset.slug, reset.sessionId) });
      deps.refreshMcpStatus();
      break;
    }
    case "lagged": {
      invalidateControlPlaneReadiness();
      deps.refreshSessionSnapshots();
      deps.requestReconnect();
      break;
    }
    case "shutdown": {
      invalidateControlPlaneReadiness();
      deps.refreshSessionSnapshots();
      deps.onShutdown();
      break;
    }
    case "mcp_status": {
      const mcpEvent = parsed as GlobalSSEMcpStatusEvent;
      useMcpStatusStore.getState().updateServer(mcpEvent.serverName, mcpEvent.status);
      break;
    }
    case "hitl.snapshot": {
      const snapshot = parsed as GlobalSSEHitlSnapshotEvent;
      hitlStore.getState().applySnapshot(snapshot);
      for (const projectSlug of snapshot.projectSlugs) {
        deps.invalidateQueries({ queryKey: ["projects", projectSlug], exact: false });
      }
      break;
    }
    case "hitl.event": {
      const hitlEvent = parsed as GlobalSSEHitlRealtimeEvent;
      hitlStore.getState().applyRealtimeEvent(hitlEvent);
      invalidateHitlRelatedQueries(deps, hitlEvent);
      break;
    }
    case "resource.changed": {
      invalidateResourceQueries(deps, parsed as GlobalSSEResourceChangedEvent);
      break;
    }
    case "session.runtime.snapshot": {
      sessionRuntimeStore.getState().applySnapshot(parsed as GlobalSSESessionRuntimeSnapshotEvent);
      deps.refreshSessionSnapshots();
      break;
    }
    case "session.runtime_changed": {
      sessionRuntimeStore.getState().applyChange(parsed as GlobalSSESessionRuntimeChangedEvent);
      break;
    }
  }
}

function invalidateResourceQueries(deps: SSEEventHandlerDeps, event: GlobalSSEResourceChangedEvent): void {
  if (event.resourceType === "goal") {
    deps.invalidateQueries({ queryKey: queryKeys.goals });
    deps.invalidateQueries({ queryKey: queryKeys.activeGoals });
    deps.invalidateQueries({ queryKey: queryKeys.projectGoals(event.projectSlug) });
    deps.invalidateQueries({ queryKey: queryKeys.goal(event.projectSlug, event.resourceId) });
    return;
  }

  invalidateLoopQueries(deps, event.projectSlug, event.resourceId);
}

function invalidateHitlRelatedQueries(deps: SSEEventHandlerDeps, event: GlobalSSEHitlRealtimeEvent): void {
  const sessionId = event.owner.ownerType === "session" ? event.owner.ownerId : sessionIdFromHitlEvent(event);
  if (sessionId) deps.invalidateQueries({ queryKey: queryKeys.session(event.projectSlug, sessionId) });

  const goalId = event.owner.ownerType === "goal" ? event.owner.ownerId : goalIdFromHitlEvent(event);
  if (goalId) deps.invalidateQueries({ queryKey: queryKeys.goal(event.projectSlug, goalId) });

  const loopId = event.owner.ownerType === "loop" ? event.owner.ownerId : loopIdFromHitlEvent(event);
  if (loopId) invalidateLoopQueries(deps, event.projectSlug, loopId);
}

function sessionIdFromHitlEvent(event: GlobalSSEHitlRealtimeEvent): string | undefined {
  const source = event.projection.source;
  if (source.type === "ask_user" || source.type === "tool_permission") return source.sessionId;
  return event.projection.ancestry?.rootSessionId;
}

function goalIdFromHitlEvent(event: GlobalSSEHitlRealtimeEvent): string | undefined {
  const source = event.projection.source;
  if (source.type === "goal_approval" || source.type === "goal_review" || source.type === "goal_budget" || source.type === "goal_question") return source.goalId;
  return event.projection.ancestry?.goalId;
}

function loopIdFromHitlEvent(event: GlobalSSEHitlRealtimeEvent): string | undefined {
  const source = event.projection.source;
  if (source.type === "loop_approval" || source.type === "loop_blocker" || source.type === "loop_retry" || source.type === "loop_question") return source.loopId;
  return event.projection.ancestry?.loopId;
}

function isGoalPayload(
  payload: SessionEventPayload,
): payload is Extract<SessionEventPayload, { type: "goal.state_change" }> {
  return payload.type === "goal.state_change";
}

function isHitlPayload(
  payload: SessionEventPayload,
): payload is Extract<SessionEventPayload, { type: "hitl.request" | "hitl.updated" | "hitl.resolved" }> {
  return payload.type === "hitl.request" || payload.type === "hitl.updated" || payload.type === "hitl.resolved";
}

function isLoopPayload(
  payload: SessionEventPayload,
): payload is Extract<SessionEventPayload, { type: "loop.state_change" | "loop.run_appended" }> {
  return payload.type === "loop.state_change" || payload.type === "loop.run_appended";
}

/** Extract loopId from any session payload that carries it (e.g. hitl.request, loop stream events). */
function extractLoopIdFromPayload(payload: SessionEventPayload): string | undefined {
  if ("loopId" in payload && typeof (payload as Record<string, unknown>).loopId === "string") {
    return (payload as Record<string, unknown>).loopId as string;
  }
  // hitl.request nests loop ownership/source inside the request object.
  if (payload.type === "hitl.request") {
    if (payload.request.owner.ownerType === "loop") return payload.request.owner.ownerId;
    const source = payload.request.source;
    if ("loopId" in source && typeof source.loopId === "string") return source.loopId;
  }
  return undefined;
}

/** Invalidate all loop guardrail query keys for a given slug + loopId. */
function invalidateLoopGuardrailQueries(
  deps: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => Promise<void> },
  slug: string,
  loopId: string,
  sessionId: string,
): void {
  invalidateLoopQueries(deps, slug, loopId);
  deps.invalidateQueries({ queryKey: queryKeys.session(slug, sessionId) });
}

function invalidateLoopQueries(
  deps: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => Promise<void> },
  slug: string,
  loopId: string,
): void {
  deps.invalidateQueries({ queryKey: queryKeys.loop(slug, loopId) });
  deps.invalidateQueries({ queryKey: queryKeys.loopRuns(slug, loopId) });
  deps.invalidateQueries({ queryKey: queryKeys.loopBudget(slug, loopId) });
  deps.invalidateQueries({ queryKey: queryKeys.loopCollisions(slug, loopId) });
  deps.invalidateQueries({ queryKey: queryKeys.loopIntegrations(slug, loopId) });
  deps.invalidateQueries({ queryKey: queryKeys.projectLoops(slug) });
  deps.invalidateQueries({ queryKey: queryKeys.activeLoops });
  deps.invalidateQueries({ queryKey: queryKeys.loopKillState(slug) });
}

export function GlobalSSEProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<GlobalSSEConnectionState>("connecting");
  const [lastError, setLastError] = useState<Error | null>(null);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState(0);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);
  const reconnectStateRef = useRef<SSEReconnectState>({ requested: false, shutdown: false });
  const watchdogRef = useRef<SSEWatchdog | null>(null);

  const refreshMcpStatus = useCallback(() => {
    getMcpStatus()
      .then((servers) => useMcpStatusStore.getState().setServers(servers))
      .catch(() => {});
  }, []);

  const requestReconnect = useCallback(() => {
    requestSSEReconnectOnce(reconnectStateRef.current, {
      invalidateReadiness: invalidateControlPlaneReadiness,
      markReconnecting: () => setConnectionState("reconnecting"),
      abortConnection: () => abortRef.current?.(),
      scheduleReconnect: () => setReconnectEpoch((epoch) => epoch + 1),
    });
  }, []);

  const refreshSessionSnapshots = useCallback(() => {
    void queryClient.invalidateQueries({
      predicate: (query) => isSessionSnapshotQueryKey(query.queryKey),
    });
  }, [queryClient]);

  const handleEvent = useCallback(
    (sseEvent: { event: string; data: string; id?: string }) => {
      handleSSEEvent(sseEvent, {
        findStore: findWebSessionStore,
        createStore: createWebSessionStore,
        invalidateQueries: (opts) => queryClient.invalidateQueries(opts),
        onShutdown: () => {
          requestSSEShutdownReconnectOnce(reconnectStateRef.current, {
            markClosed: () => setConnectionState("closed"),
            stopWatchdog: () => watchdogRef.current?.stop(),
            abortConnection: () => abortRef.current?.(),
            markReconnecting: () => setConnectionState("reconnecting"),
            scheduleReconnect: () => setReconnectEpoch((epoch) => epoch + 1),
          });
        },
        onHeartbeat: (createdAt) => {
          watchdogRef.current?.heartbeatReceived();
          setLastHeartbeatAt(createdAt);
        },
        refreshMcpStatus,
        requestReconnect,
        refreshSessionSnapshots,
      });
    },
    [queryClient, refreshMcpStatus, refreshSessionSnapshots, requestReconnect],
  );

  const handleError = useCallback((error: unknown) => {
    if (error instanceof Error) {
      setLastError(error);
    } else {
      setLastError(new Error(typeof error === "string" ? error : "SSE connection error"));
    }
  }, []);

  useEffect(() => {
    reconnectStateRef.current.shutdown = false;
    const watchdog = createSSEWatchdog({ onTimeout: requestReconnect });
    watchdogRef.current = watchdog;

    return () => {
      cancelSSEShutdownReconnect(reconnectStateRef.current);
      reconnectStateRef.current.shutdown = true;
      watchdog.stop();
      if (watchdogRef.current === watchdog) watchdogRef.current = null;
    };
  }, [requestReconnect]);

  useEffect(() => {
    invalidateControlPlaneReadiness();
    setConnectionState("connecting");

    const client = connectSSE("/api/events", {
      onEvent: handleEvent,
      onError: handleError,
      onConnectionAttempt: () => {
        reconnectStateRef.current.requested = false;
        watchdogRef.current?.connectionAttemptStarted();
      },
      onConnectionOpen: () => {
        reconnectStateRef.current.requested = false;
        watchdogRef.current?.connectionOpened();
        refreshSessionSnapshots();
        setConnectionState("open");
      },
      onConnectionLost: () => {
        watchdogRef.current?.stop();
        invalidateControlPlaneReadiness();
        refreshSessionSnapshots();
        setConnectionState("reconnecting");
      },
    });

    abortRef.current = client.abort;

    return () => {
      abortRef.current = null;
      client.abort();
    };
  }, [handleEvent, handleError, reconnectEpoch, refreshSessionSnapshots]);

  useEffect(() => {
    refreshMcpStatus();
  }, [refreshMcpStatus]);

  const value: GlobalSSEContextValue = {
    connectionState,
    lastError,
    lastHeartbeatAt,
  };

  return createElement(GlobalSSEContext.Provider, { value }, children);
}

export function useGlobalSSE(): GlobalSSEContextValue {
  const ctx = useContext(GlobalSSEContext);
  if (!ctx) {
    throw new Error("useGlobalSSE must be used within GlobalSSEProvider");
  }
  return ctx;
}
