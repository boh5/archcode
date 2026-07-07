import { createContext, useContext, useEffect, useRef, useState, useCallback, createElement, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectSSE } from "../lib/sse-client";
import { createWebSessionStore, findWebSessionStore } from "../store/session-store";
import { useMcpStatusStore } from "../store/mcp-status-store";
import { getMcpStatus } from "../api/mcp";
import { queryKeys } from "../api/queries";
import type {
  GlobalSSEEvent,
  GlobalSessionEventEnvelope,
  GlobalSSEHeartbeatEvent,
  GlobalSSEHitlChangedEvent,
  GlobalSSEMcpStatusEvent,
  GlobalSSEResetEvent,
  SessionEventPayload,
} from "@archcode/protocol";

export type GlobalSSEConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface GlobalSSEContextValue {
  connectionState: GlobalSSEConnectionState;
  lastError: Error | null;
  lastHeartbeatAt: number;
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
      case "hitl.changed":
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
        deps.invalidateQueries({ queryKey: queryKeys.hitl });
        deps.invalidateQueries({ queryKey: queryKeys.projectHitl(envelope.slug) });
        deps.invalidateQueries({ queryKey: ["projects", envelope.slug, "hitl"], exact: false });
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
      break;
    }
    case "shutdown": {
      deps.onShutdown();
      break;
    }
    case "mcp_status": {
      const mcpEvent = parsed as GlobalSSEMcpStatusEvent;
      useMcpStatusStore.getState().updateServer(mcpEvent.serverName, mcpEvent.status);
      break;
    }
    case "hitl.changed": {
      invalidateHitlChangedQueries(deps, parsed as GlobalSSEHitlChangedEvent);
      break;
    }
  }
}

function invalidateHitlChangedQueries(deps: SSEEventHandlerDeps, event: GlobalSSEHitlChangedEvent): void {
  deps.invalidateQueries({ queryKey: queryKeys.hitl });
  deps.invalidateQueries({ queryKey: queryKeys.projectHitl(event.projectSlug) });
  deps.invalidateQueries({ queryKey: ["projects", event.projectSlug, "hitl"], exact: false });

  const sessionId = event.sessionId ?? (event.ownerType === "session" ? event.ownerId : undefined);
  if (sessionId) deps.invalidateQueries({ queryKey: queryKeys.session(event.projectSlug, sessionId) });

  const goalId = event.goalId ?? (event.ownerType === "goal" ? event.ownerId : undefined);
  if (goalId) deps.invalidateQueries({ queryKey: queryKeys.goal(event.projectSlug, goalId) });

  const loopId = event.loopId ?? (event.ownerType === "loop" ? event.ownerId : undefined);
  if (loopId) invalidateLoopQueries(deps, event.projectSlug, loopId);
}

function isGoalPayload(
  payload: SessionEventPayload,
): payload is Extract<SessionEventPayload, { type: "goal.state_change" | "goal.done_check" | "goal.escalation" }> {
  return payload.type === "goal.state_change" || payload.type === "goal.done_check" || payload.type === "goal.escalation";
}

function isHitlPayload(
  payload: SessionEventPayload,
): payload is Extract<SessionEventPayload, { type: "hitl.request" | "hitl.resolved" }> {
  return payload.type === "hitl.request" || payload.type === "hitl.resolved";
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
  const abortRef = useRef<(() => void) | null>(null);
  const shutdownRef = useRef(false);

  const refreshMcpStatus = useCallback(() => {
    getMcpStatus()
      .then((servers) => useMcpStatusStore.getState().setServers(servers))
      .catch(() => {});
  }, []);

  const handleEvent = useCallback(
    (sseEvent: { event: string; data: string; id?: string }) => {
      handleSSEEvent(sseEvent, {
        findStore: findWebSessionStore,
        createStore: createWebSessionStore,
        invalidateQueries: (opts) => queryClient.invalidateQueries(opts),
        onShutdown: () => {
          shutdownRef.current = true;
          setConnectionState("closed");
          abortRef.current?.();
        },
        onHeartbeat: (createdAt) => setLastHeartbeatAt(createdAt),
        refreshMcpStatus,
      });
    },
    [queryClient, refreshMcpStatus],
  );

  const handleError = useCallback((error: unknown) => {
    if (error instanceof Error) {
      setLastError(error);
    } else {
      setLastError(new Error(typeof error === "string" ? error : "SSE connection error"));
    }
  }, []);

  useEffect(() => {
    shutdownRef.current = false;
    setConnectionState("connecting");

    const client = connectSSE("/api/events", {
      onEvent: handleEvent,
      onError: handleError,
    });

    abortRef.current = client.abort;

    client.closed.then(() => {
      if (!shutdownRef.current) {
        setConnectionState("reconnecting");
      }
    });

    return () => {
      abortRef.current = null;
      client.abort();
    };
  }, [handleEvent, handleError]);

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
