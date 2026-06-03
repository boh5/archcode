import type { StoreApi } from "zustand";
import { createEmptySessionStats } from "@specra/protocol";
import type { SessionStoreState } from "./types";

export function createMockStore(
  overrides?: Partial<SessionStoreState>,
): StoreApi<SessionStoreState> {
  const state: SessionStoreState = {
    sessionId: "test",
    agentName: "orchestrator",
    title: null,
    createdAt: Date.now(),
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    todos: [],
    reminders: [],
    childSessionLinks: [],
    rootSessionId: "test",
    isRunning: false,
    isStreamingModel: false,
    readSnapshots: new Map(),
    executionCount: 0,
    lastTodoWriteStepIndex: null,
    lastTodoReminderStepIndex: null,
    todoStepReminderCount: 0,
    todoLoopContinuationCount: 0,
    todoContinuationStagnationCount: 0,
    lastTodoContinuationPendingCount: null,
    lastExtractionIndex: 0,
    lastExtractionTime: 0,
    events: [],
    eventOffset: 0,
    nextEventId: 0,
    append: (event) => {
      state.events = [...state.events, {
        id: state.nextEventId,
        createdAt: Date.now(),
        kind: event.type,
        payload: event,
      }];
      state.nextEventId += 1;

      switch (event.type) {
        case "reminder": {
          state.reminders = [...state.reminders, { ...event.reminder, consumedAt: null }];
          break;
        }
        case "todo-write": {
          state.todos = [...event.todos];
          break;
        }
        case "reminder-consumed": {
          const consumedIds = new Set(event.reminderIds);
          state.reminders = state.reminders.map((r) =>
            consumedIds.has(r.id) && r.consumedAt === null
              ? { ...r, consumedAt: Date.now() }
              : r,
          );
          break;
        }
      }
    },
    setTitle: (title) => {
      state.title = title;
    },
    setParentSessionId: (parentSessionId) => {
      state.parentSessionId = parentSessionId;
    },
    setWorkflowId: (workflowId) => {
      state.workflowId = workflowId;
    },
    toModelMessages: () => [],
  };

  if (overrides) {
    Object.assign(state, overrides);
  }

  return {
    getState: () => state,
    getInitialState: () => state,
    setState: (partial) => {
      if (typeof partial === "function") {
        Object.assign(state, (partial as (s: SessionStoreState) => Partial<SessionStoreState>)(state));
      } else {
        Object.assign(state, partial);
      }
    },
    subscribe: () => () => {},
  };
}
