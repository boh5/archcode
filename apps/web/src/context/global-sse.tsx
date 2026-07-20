import { createContext, useContext, useEffect, useRef, useState, useCallback, createElement, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { connectSSE } from "../lib/sse-client";
import { createWebSessionStore, findWebSessionStore } from "../store/session-store";
import { hitlAttentionPath, hitlStore, scopedHitlIdentity, type ScopedHitlView } from "../store/hitl-store";
import { useMcpStatusStore } from "../store/mcp-status-store";
import { sessionRuntimeStore } from "../store/session-runtime-store";
import { invalidateControlPlaneReadiness } from "../store/control-plane-readiness";
import { getMcpStatus } from "../api/mcp";
import { queryKeys } from "../api/queries";
import {
  isGlobalSSEHitlRealtimeEvent,
  isGlobalSSEHitlSnapshotEvent,
  isGlobalSSEResourceChangedEvent,
  isSessionEventPayload,
} from "@archcode/protocol";
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
} from "@archcode/protocol";

export type GlobalSSEConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface GlobalSSEContextValue {
  connectionState: GlobalSSEConnectionState;
  lastError: Error | null;
  lastHeartbeatAt: number;
  /** Ephemeral announcement identities; visible HITL data remains owned by hitlStore. */
  hitlNoticeIdentities: readonly string[];
}

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_WATCHDOG_TIMEOUT_MS = SSE_HEARTBEAT_INTERVAL_MS * 3;
export const SSE_SHUTDOWN_RECONNECT_DELAY_MS = 1_000;

export interface HitlNotificationGate {
  beginConnection: () => void;
  observeSnapshot: (event: GlobalSSEHitlSnapshotEvent) => void;
  observeRealtimeEvent: (event: GlobalSSEHitlRealtimeEvent) => ScopedHitlView | null;
}

export function createHitlNotificationGate(): HitlNotificationGate {
  let baseline = new Set<string>();
  let seen = new Set<string>();
  return {
    beginConnection: () => {
      baseline = new Set();
      seen = new Set();
    },
    observeSnapshot: (event) => {
      for (const rawEntry of event.entries) {
        baseline.add(scopedHitlIdentity({
          projectSlug: rawEntry.projectSlug,
          ownerSessionId: rawEntry.ownerSessionId,
          view: rawEntry.view,
        }));
      }
    },
    observeRealtimeEvent: (event) => {
      if (event.payload.type !== "hitl.request") return null;
      const entry: ScopedHitlView = {
        projectSlug: event.projectSlug,
        ownerSessionId: event.ownerSessionId,
        rootSessionId: event.rootSessionId,
        view: event.view,
      };
      const identity = scopedHitlIdentity(entry);
      if (baseline.has(identity) || seen.has(identity)) return null;
      seen.add(identity);
      return entry;
    },
  };
}

export interface HitlForegroundEnvironment {
  readonly visibilityState: DocumentVisibilityState;
  readonly hasFocus: boolean;
  readonly pathname: string;
  readonly search: string;
}

export function isHitlOwnerForeground(
  entry: ScopedHitlView,
  environment?: HitlForegroundEnvironment,
): boolean {
  const current = environment ?? readHitlForegroundEnvironment();
  if (!current || current.visibilityState !== "visible" || !current.hasFocus) return false;
  const expectedPath = `/projects/${encodeURIComponent(entry.projectSlug)}/sessions/${encodeURIComponent(entry.rootSessionId)}`;
  if (current.pathname !== expectedPath) return false;
  const focus = new URLSearchParams(current.search).get("focus");
  return focus === null
    ? entry.ownerSessionId === entry.rootSessionId
    : entry.ownerSessionId === focus;
}

function readHitlForegroundEnvironment(): HitlForegroundEnvironment | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  return {
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

export interface BrowserHitlNotificationEnvironment {
  readonly visibilityState: DocumentVisibilityState;
  readonly permission: NotificationPermission | "unsupported";
  readonly createNotification: (title: string, body: string, onClick: () => void) => void;
  readonly focusWindow: () => void;
  readonly navigate: (path: string) => void;
}

export function showHiddenBrowserHitlNotification(
  entry: ScopedHitlView,
  environment?: BrowserHitlNotificationEnvironment,
): boolean {
  const current = environment ?? readBrowserHitlNotificationEnvironment();
  if (!current || current.visibilityState !== "hidden" || current.permission !== "granted") return false;
  current.createNotification(
    "ArchCode needs your attention",
    entry.view.displayPayload.title,
    () => {
      current.focusWindow();
      current.navigate(hitlAttentionPath(entry));
    },
  );
  return true;
}

function readBrowserHitlNotificationEnvironment(): BrowserHitlNotificationEnvironment | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  return {
    visibilityState: document.visibilityState,
    permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    createNotification: (title, body, onClick) => {
      if (typeof Notification === "undefined") throw new Error("Notification API unavailable");
      const notification = new Notification(title, { body });
      notification.onclick = onClick;
    },
    focusWindow: () => window.focus(),
    navigate: (path) => window.location.assign(path),
  };
}

export function resolveHitlNoticeEntries(
  identities: readonly string[],
  views: Readonly<Record<string, ScopedHitlView>>,
): readonly ScopedHitlView[] {
  const entriesByIdentity = new Map(
    Object.values(views).map((entry) => [scopedHitlIdentity(entry), entry] as const),
  );
  return identities.flatMap((identity) => {
    const entry = entriesByIdentity.get(identity);
    return entry ? [entry] : [];
  });
}

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

export function isProjectTodoQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === "projects"
    && typeof queryKey[1] === "string"
    && queryKey[2] === "todos"
    && (queryKey.length === 3 || (queryKey.length === 4 && typeof queryKey[3] === "string"));
}

export function refreshProjectTodoQueriesAfterSSEOpen(
  queryClient: Pick<QueryClient, "invalidateQueries">,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => isProjectTodoQueryKey(query.queryKey),
    refetchType: "active",
  });
}

const GlobalSSEContext = createContext<GlobalSSEContextValue | null>(null);

export function parseSSEEvent(_event: string, data: string): GlobalSSEEvent | null {
  try {
    const parsed = JSON.parse(data) as GlobalSSEEvent;
    switch (parsed.type) {
      case "event":
        return isGlobalSessionEventEnvelope(parsed) ? parsed : null;
      case "heartbeat":
      case "reset":
      case "lagged":
      case "shutdown":
      case "mcp_status":
      case "model_runtime.changed":
      case "session.runtime.snapshot":
      case "session.runtime_changed":
        return parsed;
      case "hitl.snapshot":
        return isGlobalSSEHitlSnapshotEvent(parsed) ? parsed : null;
      case "hitl.event":
        return isGlobalSSEHitlRealtimeEvent(parsed) ? parsed : null;
      case "resource.changed":
        return isGlobalSSEResourceChangedEvent(parsed) ? parsed : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function isGlobalSessionEventEnvelope(value: unknown): value is GlobalSessionEventEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const expected = ["type", "slug", "sessionId", "eventId", "createdAt", "payload", "agentName"] as const;
  return Object.keys(record).length === expected.length
    && expected.every((key) => Object.hasOwn(record, key))
    && record.type === "event"
    && typeof record.slug === "string"
    && typeof record.sessionId === "string"
    && typeof record.eventId === "number"
    && typeof record.createdAt === "number"
    && typeof record.agentName === "string"
    && isSessionEventPayload(record.payload);
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
  hitlNotificationGate?: HitlNotificationGate;
  onLiveHitlRequest?: (entry: ScopedHitlView) => void;
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
          title: link.title ?? null,
          createdAt: link.createdAt,
        });
      }

      if (envelope.payload.type === "execution-start" || envelope.payload.type === "execution-end") {
        deps.invalidateQueries({
          queryKey: queryKeys.session(envelope.slug, envelope.sessionId),
        });
        deps.invalidateQueries({ queryKey: queryKeys.sessions(envelope.slug) });
        if (store.getState().rootSessionId === envelope.sessionId) invalidateDashboardProjectionQueries(deps, envelope.slug);
      }

      if (envelope.payload.type === "session.goal_changed") {
        // The event itself keeps any open Session projection live. These REST
        // projections feed the Session rail and Dashboard, so invalidate them
        // as one atomic user-visible Goal transition.
        deps.invalidateQueries({
          queryKey: queryKeys.session(envelope.slug, envelope.sessionId),
        });
        deps.invalidateQueries({ queryKey: queryKeys.sessions(envelope.slug) });
        invalidateDashboardProjectionQueries(deps, envelope.slug);
      }

      if (
        envelope.payload.type === "session.model_selection_changed"
        ||
        envelope.payload.type === "session.message_accepted"
        || envelope.payload.type === "session.message_edited"
        || envelope.payload.type === "session.message_deleted"
        || envelope.payload.type === "session.message_steer_claimed"
        || envelope.payload.type === "session.message_steer_rolled_back"
        || envelope.payload.type === "session.messages_committed"
      ) {
        // The event reducer updates the live projection. Invalidate the REST
        // snapshot as a recovery path for a reconnect or an older event ring.
        deps.invalidateQueries({
          queryKey: queryKeys.session(envelope.slug, envelope.sessionId),
        });
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
      invalidateDashboardProjectionQueries(deps, reset.slug);
      deps.refreshMcpStatus();
      break;
    }
    case "lagged": {
      invalidateControlPlaneReadiness();
      deps.refreshSessionSnapshots();
      deps.invalidateQueries({ queryKey: ["dashboard"] });
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
    case "model_runtime.changed": {
      deps.invalidateQueries({ queryKey: queryKeys.modelRuntime });
      deps.refreshSessionSnapshots();
      break;
    }
    case "hitl.snapshot": {
      const snapshot = parsed as GlobalSSEHitlSnapshotEvent;
      hitlStore.getState().applySnapshot(snapshot);
      deps.hitlNotificationGate?.observeSnapshot(snapshot);
      break;
    }
    case "hitl.event": {
      const hitlEvent = parsed as GlobalSSEHitlRealtimeEvent;
      hitlStore.getState().applyRealtimeEvent(hitlEvent);
      const entry = deps.hitlNotificationGate?.observeRealtimeEvent(hitlEvent);
      if (entry) deps.onLiveHitlRequest?.(entry);
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
  if (event.resourceType === "automation") {
    invalidateAutomationQueries(deps, event.projectSlug, event.resourceId);
    invalidateDashboardProjectionQueries(deps, event.projectSlug);
    return;
  }

  if (event.resourceType === "todo") {
    deps.invalidateQueries({ queryKey: queryKeys.projectTodos(event.projectSlug) });
    deps.invalidateQueries({ queryKey: queryKeys.projectTodo(event.projectSlug, event.resourceId) });
  }
}

function invalidateAutomationQueries(
  deps: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => Promise<void> },
  slug: string,
  automationId: string,
): void {
  deps.invalidateQueries({ queryKey: queryKeys.automation(slug, automationId) });
  deps.invalidateQueries({ queryKey: queryKeys.automationInvocations(slug, automationId) });
  deps.invalidateQueries({ queryKey: queryKeys.projectAutomations(slug) });
}

function invalidateDashboardProjectionQueries(
  deps: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => Promise<void> },
  projectSlug: string,
): void {
  deps.invalidateQueries({ queryKey: queryKeys.dashboardProjection({ kind: "global" }) });
  deps.invalidateQueries({ queryKey: queryKeys.dashboardProjection({ kind: "project", projectSlug }) });
}

export function GlobalSSEProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<GlobalSSEConnectionState>("connecting");
  const [lastError, setLastError] = useState<Error | null>(null);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState(0);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [hitlNoticeIdentities, setHitlNoticeIdentities] = useState<readonly string[]>([]);
  const abortRef = useRef<(() => void) | null>(null);
  const reconnectStateRef = useRef<SSEReconnectState>({ requested: false, shutdown: false });
  const watchdogRef = useRef<SSEWatchdog | null>(null);
  const hitlNotificationGateRef = useRef<HitlNotificationGate>(createHitlNotificationGate());

  const announceLiveHitl = useCallback((entry: ScopedHitlView) => {
    if (entry.view.displayPayload.redacted !== true) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      showHiddenBrowserHitlNotification(entry);
      return;
    }
    if (isHitlOwnerForeground(entry)) return;
    const identity = scopedHitlIdentity(entry);
    setHitlNoticeIdentities((current) => current.includes(identity) ? current : [...current, identity]);
    setTimeout(() => setHitlNoticeIdentities((current) => current.filter((noticeIdentity) => noticeIdentity !== identity)), 8_000);
  }, []);

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

  const refreshDashboardProjections = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
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
        hitlNotificationGate: hitlNotificationGateRef.current,
        onLiveHitlRequest: announceLiveHitl,
      });
    },
    [announceLiveHitl, queryClient, refreshMcpStatus, refreshSessionSnapshots, requestReconnect],
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
        hitlNotificationGateRef.current.beginConnection();
        watchdogRef.current?.connectionAttemptStarted();
      },
      onConnectionOpen: () => {
        reconnectStateRef.current.requested = false;
        watchdogRef.current?.connectionOpened();
        refreshSessionSnapshots();
        refreshDashboardProjections();
        void queryClient.invalidateQueries({ queryKey: queryKeys.modelRuntime });
        void refreshProjectTodoQueriesAfterSSEOpen(queryClient);
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
  }, [handleEvent, handleError, queryClient, reconnectEpoch, refreshDashboardProjections, refreshSessionSnapshots]);

  useEffect(() => {
    refreshMcpStatus();
  }, [refreshMcpStatus]);

  const value: GlobalSSEContextValue = {
    connectionState,
    lastError,
    lastHeartbeatAt,
    hitlNoticeIdentities,
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
