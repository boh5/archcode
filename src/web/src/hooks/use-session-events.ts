import { useEffect, useRef } from "react";
import type { SessionEventPayload } from "../../../store/types";
import type { PermissionRequest, QuestionRequest } from "../api/types";
import { createWebSessionStore } from "../store/session-store";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type SessionEventType = "stream" | "heartbeat" | "reset";

export function useSessionEvents(
  slug: string,
  sessionId: string,
  options?: { eventCursor?: number; onReset?: () => void },
): void {
  const onResetRef = useRef(options?.onReset);
  onResetRef.current = options?.onReset;

  useEffect(() => {
    const store = createWebSessionStore(sessionId, slug);
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
      if (lastEventId) {
        return `${baseUrl}?lastEventId=${encodeURIComponent(lastEventId)}`;
      }
      if (options?.eventCursor !== undefined) {
        return `${baseUrl}?lastEventId=${encodeURIComponent(String(options.eventCursor))}`;
      }
      return baseUrl;
    };

    const handleStreamEvent = (payload: SessionEventPayload) => {
      if (disposed) return;
      const state = store.getState();

      switch (payload.type) {
        case "permission.request": {
          const mapped: PermissionRequest = {
            id: payload.permissionId,
            sessionId,
            toolName: payload.toolName,
            toolCallId: "",
            input: payload.args,
            description: payload.description ?? "",
          };
          state.addPermissionRequest(mapped);
          break;
        }
        case "question.request": {
          let parsed: { toolName?: string; toolCallId?: string; questions?: unknown[] } = {};
          try {
            parsed = JSON.parse(payload.question);
          } catch {
            parsed = {};
          }
          const mapped: QuestionRequest = {
            id: payload.questionId,
            sessionId,
            toolName: parsed.toolName ?? "ask_user",
            toolCallId: parsed.toolCallId ?? "",
            questions: parsed.questions ?? [{ text: payload.question }],
          };
          state.addQuestionRequest(mapped);
          break;
        }
        case "permission.terminal":
          state.handlePermissionTerminal(payload);
          break;
        case "question.terminal":
          state.handleQuestionTerminal(payload);
          break;
        case "shutdown":
          state.setConnectionState("closed");
          closeEventSource();
          break;
        default:
          state.append(payload);
          break;
      }
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
        let payload: SessionEventPayload;
        try {
          payload = JSON.parse((event as MessageEvent<string>).data) as SessionEventPayload;
        } catch {
          return;
        }
        handleStreamEvent(payload);
        updateLastEventId(event as MessageEvent<string>);
      });
      source.addEventListener("heartbeat", () => {});
      source.addEventListener("reset", () => {
        if (disposed) return;
        store.getState().resetTransientState();
        closeEventSource();
        onResetRef.current?.();
      });
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimeout();
      closeEventSource();
    };
  }, [sessionId, slug, options?.eventCursor]);
}
