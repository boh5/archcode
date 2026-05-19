import type { ModelMessage } from "ai";
import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { toModelMessagesFromStoredMessages } from "./projection";
import { reduceStreamEvent } from "./reduce";
import {
  type SessionStoreState,
  type StreamEvent,
} from "./types";

const sessionRegistry = new Map<string, StoreApi<SessionStoreState>>();

export function scopedKey(workspaceRoot: string, sessionId: string): string {
  return `${workspaceRoot}\0${sessionId}`;
}

function registryKey(sessionId: string, workspaceRoot?: string): string {
  return workspaceRoot === undefined ? sessionId : scopedKey(workspaceRoot, sessionId);
}

export function createSessionStore(
  sessionId: string,
  workspaceRoot?: string,
): StoreApi<SessionStoreState> {
  const key = registryKey(sessionId, workspaceRoot);
  const existing = sessionRegistry.get(key);
  if (existing) return existing;

  const store = createStore<SessionStoreState>((set, get) => ({
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
    append: (event: StreamEvent) => {
      set((state) => reduceStreamEvent(state, event));
    },
    toModelMessages: (): ModelMessage[] =>
      toModelMessagesFromStoredMessages(get().messages),
  }));

  sessionRegistry.set(key, store);
  return store;
}

export function getSessionStore(
  sessionId: string,
  workspaceRoot?: string,
): StoreApi<SessionStoreState> | undefined {
  return sessionRegistry.get(registryKey(sessionId, workspaceRoot));
}

export function deleteSessionStore(sessionId: string, workspaceRoot?: string): boolean {
  return sessionRegistry.delete(registryKey(sessionId, workspaceRoot));
}

export function clearAllSessionStores(): void {
  sessionRegistry.clear();
}
