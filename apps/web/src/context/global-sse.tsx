import { createContext, useContext, useEffect, useRef, useState, useCallback, createElement, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectSSE } from "../lib/sse-client";
import { createWebSessionStore, findWebSessionStore } from "../store/session-store";
import { queryKeys } from "../api/queries";
import type {
  GlobalSSEEvent,
  GlobalSessionEventEnvelope,
  GlobalSSEHeartbeatEvent,
  GlobalSSEResetEvent,
} from "@specra/protocol";

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
  invalidateQueries: (opts: { queryKey: readonly unknown[] }) => Promise<void>;
  onShutdown: () => void;
  onHeartbeat: (createdAt: number) => void;
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
          title: link.title ?? link.description ?? null,
          createdAt: link.createdAt,
        });
      }

      if (envelope.payload.type === "workflow.state_change") {
        deps.invalidateQueries({
          queryKey: queryKeys.workflow(envelope.slug, envelope.payload.workflowId),
        });
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
      break;
    }
    case "lagged": {
      break;
    }
    case "shutdown": {
      deps.onShutdown();
      break;
    }
  }
}

export function GlobalSSEProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<GlobalSSEConnectionState>("connecting");
  const [lastError, setLastError] = useState<Error | null>(null);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);
  const shutdownRef = useRef(false);

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
      });
    },
    [queryClient],
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
