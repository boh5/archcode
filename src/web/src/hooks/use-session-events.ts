import { useEffect } from "react";
import type { StreamEvent } from "../../../store/types";
import type { PermissionRequest, QuestionRequest } from "../api/types";
import { createWebSessionStore } from "../store/session-store";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type SessionEventType =
  | "stream"
  | "permission.request"
  | "question.request"
  | "heartbeat"
  | "shutdown";

export function useSessionEvents(slug: string, sessionId: string): void {
  useEffect(() => {
    const store = createWebSessionStore(sessionId);
    let eventSource: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    let disposed = false;

    const clearReconnectTimeout = () => {
      if (reconnectTimeout === null) return;
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    };

    const closeEventSource = () => {
      if (eventSource === null) return;
      eventSource.close();
      eventSource = null;
    };

    const updateLastEventId = (event: MessageEvent<string>) => {
      if (event.lastEventId) {
        store.getState().setLastEventId(event.lastEventId);
      }
    };

    const buildUrl = () => {
      const baseUrl = `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/events`;
      const lastEventId = store.getState().lastEventId;
      if (!lastEventId) return baseUrl;

      return `${baseUrl}?lastEventId=${encodeURIComponent(lastEventId)}`;
    };

    const handleEvent = (type: SessionEventType, event: MessageEvent<string>) => {
      if (disposed) return;

      const state = store.getState();
      switch (type) {
        case "stream":
          state.append(JSON.parse(event.data) as StreamEvent);
          break;
        case "permission.request":
          state.addPermissionRequest(JSON.parse(event.data) as PermissionRequest);
          break;
        case "question.request":
          state.addQuestionRequest(JSON.parse(event.data) as QuestionRequest);
          break;
        case "heartbeat":
          break;
        case "shutdown":
          state.setConnectionState("closed");
          closeEventSource();
          break;
      }

      updateLastEventId(event);
    };

    const connect = () => {
      if (disposed) return;

      clearReconnectTimeout();
      closeEventSource();
      store.getState().setConnectionState(
        reconnectDelayMs === INITIAL_RECONNECT_DELAY_MS ? "connecting" : "reconnecting",
      );

      const source = new EventSource(buildUrl());
      eventSource = source;

      source.onopen = () => {
        if (disposed || eventSource !== source) return;
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        store.getState().setConnectionState("open");
      };

      source.onerror = () => {
        if (disposed || eventSource !== source) return;

        source.close();
        eventSource = null;
        store.getState().setConnectionState("reconnecting");

        const delay = reconnectDelayMs;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
        reconnectTimeout = setTimeout(connect, delay);
      };

      source.addEventListener("stream", (event) => {
        handleEvent("stream", event as MessageEvent<string>);
      });
      source.addEventListener("permission.request", (event) => {
        handleEvent("permission.request", event as MessageEvent<string>);
      });
      source.addEventListener("question.request", (event) => {
        handleEvent("question.request", event as MessageEvent<string>);
      });
      source.addEventListener("heartbeat", (event) => {
        handleEvent("heartbeat", event as MessageEvent<string>);
      });
      source.addEventListener("shutdown", (event) => {
        handleEvent("shutdown", event as MessageEvent<string>);
      });
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimeout();
      closeEventSource();
    };
  }, [sessionId, slug]);
}
