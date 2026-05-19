import type { StoreApi } from "zustand";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import { reduceStreamEvent } from "../../../store/reduce";
import type {
  PermissionTerminalEvent,
  QuestionTerminalEvent,
  SessionEventPayload,
  SessionStoreState,
  StreamEvent,
} from "../../../store/types";
import type { PermissionRequest, QuestionRequest } from "../api/types";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface WebSessionStoreState extends SessionStoreState {
  pendingPermissions: Map<string, PermissionRequest>;
  pendingQuestions: Map<string, QuestionRequest>;
  lastEventId: string | null;
  connectionState: ConnectionState;
  addPermissionRequest: (request: PermissionRequest) => void;
  removePermissionRequest: (id: string) => void;
  addQuestionRequest: (request: QuestionRequest) => void;
  removeQuestionRequest: (id: string) => void;
  handlePermissionTerminal: (event: PermissionTerminalEvent) => void;
  handleQuestionTerminal: (event: QuestionTerminalEvent) => void;
  resetTransientState: () => void;
  setConnectionState: (state: ConnectionState) => void;
  setLastEventId: (id: string | null) => void;
}

const sessionRegistry = new Map<string, StoreApi<WebSessionStoreState>>();

function scopedWebKey(slug: string, sessionId: string): string {
  return `${slug}\0${sessionId}`;
}

export function createWebSessionStore(
  sessionId: string,
  slug?: string,
): StoreApi<WebSessionStoreState> {
  const key = slug === undefined ? sessionId : scopedWebKey(slug, sessionId);
  const existing = sessionRegistry.get(key);
  if (existing) return existing;

  const store = createStore<WebSessionStoreState>((set) => ({
    sessionId,
    createdAt: Date.now(),
    title: null,
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionIds: new Set(),
    parentSessionId: undefined,
    subAgentDescriptions: new Map(),
    isRunning: false,
    isStreamingModel: false,
    readSnapshots: new Map(),
    runCount: 0,
    lastTodoWriteStepIndex: null,
    lastTodoReminderStepIndex: null,
    todoStepReminderCount: 0,
    todoLoopContinuationCount: 0,
    todoContinuationStagnationCount: 0,
    lastTodoContinuationPendingCount: null,
    events: [],
    eventOffset: 0,
    nextEventId: 0,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    lastEventId: null,
    connectionState: "connecting",
    append: (event: SessionEventPayload) => {
      set((state) => {
        const envelope = {
          id: state.nextEventId,
          createdAt: Date.now(),
          kind: event.type,
          payload: event,
        };

        const events = [...state.events, envelope];
        const nextEventId = state.nextEventId + 1;
        let eventOffset = state.eventOffset;

        if (events.length > 10000) {
          const dropCount = events.length - 10000;
          events.splice(0, dropCount);
          eventOffset += dropCount;
        }

        const partial = reduceStreamEvent(state, event as StreamEvent);

        return { ...partial, events, eventOffset, nextEventId };
      });
    },
    toModelMessages: () => [],
    addPermissionRequest: (request: PermissionRequest) => {
      set((state) => ({
        pendingPermissions: new Map(state.pendingPermissions).set(request.id, request),
      }));
    },
    removePermissionRequest: (id: string) => {
      set((state) => {
        const pendingPermissions = new Map(state.pendingPermissions);
        pendingPermissions.delete(id);
        return { pendingPermissions };
      });
    },
    addQuestionRequest: (request: QuestionRequest) => {
      set((state) => ({
        pendingQuestions: new Map(state.pendingQuestions).set(request.id, request),
      }));
    },
    removeQuestionRequest: (id: string) => {
      set((state) => {
        const pendingQuestions = new Map(state.pendingQuestions);
        pendingQuestions.delete(id);
        return { pendingQuestions };
      });
    },
    handlePermissionTerminal: (event: PermissionTerminalEvent) => {
      set((state) => {
        const pendingPermissions = new Map(state.pendingPermissions);
        pendingPermissions.delete(event.permissionId);
        return { pendingPermissions };
      });
    },
    handleQuestionTerminal: (event: QuestionTerminalEvent) => {
      set((state) => {
        const pendingQuestions = new Map(state.pendingQuestions);
        pendingQuestions.delete(event.questionId);
        return { pendingQuestions };
      });
    },
    resetTransientState: () => {
      set({
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        connectionState: "connecting",
        lastEventId: null,
      });
    },
    setConnectionState: (connectionState: ConnectionState) => {
      set({ connectionState });
    },
    setLastEventId: (lastEventId: string | null) => {
      set({ lastEventId });
    },
  }));

  sessionRegistry.set(key, store);
  return store;
}

export function useSessionStore<T>(
  sessionId: string,
  selector: (state: WebSessionStoreState) => T,
  slug?: string,
): T {
  return useStore(createWebSessionStore(sessionId, slug), selector);
}
