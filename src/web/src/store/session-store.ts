import type { StoreApi } from "zustand";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import { reduceStreamEvent } from "../../../store/reduce";
import type { SessionStoreState, StreamEvent } from "../../../store/types";
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
  setConnectionState: (state: ConnectionState) => void;
  setLastEventId: (id: string | null) => void;
}

const sessionRegistry = new Map<string, StoreApi<WebSessionStoreState>>();

export function createWebSessionStore(
  sessionId: string,
): StoreApi<WebSessionStoreState> {
  const existing = sessionRegistry.get(sessionId);
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
    streamingTools: {},
    readSnapshots: new Map(),
    runCount: 0,
    lastTodoWriteStepIndex: null,
    lastTodoReminderStepIndex: null,
    todoStepReminderCount: 0,
    todoLoopContinuationCount: 0,
    todoContinuationStagnationCount: 0,
    lastTodoContinuationPendingCount: null,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    lastEventId: null,
    connectionState: "connecting",
    append: (event: StreamEvent) => {
      set((state) => reduceStreamEvent(state, event));
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
    setConnectionState: (connectionState: ConnectionState) => {
      set({ connectionState });
    },
    setLastEventId: (lastEventId: string | null) => {
      set({ lastEventId });
    },
  }));

  sessionRegistry.set(sessionId, store);
  return store;
}

export function useSessionStore<T>(
  sessionId: string,
  selector: (state: WebSessionStoreState) => T,
): T {
  return useStore(createWebSessionStore(sessionId), selector);
}
