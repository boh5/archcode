import type { StoreApi } from "zustand";
import type { SessionStoreState } from "./types";

export function createMockStore(
  overrides?: Partial<SessionStoreState>,
): StoreApi<SessionStoreState> {
  const state: SessionStoreState = {
    sessionId: "test",
    title: null,
    createdAt: Date.now(),
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionIds: new Set(),
    subAgentDescriptions: new Map(),
    isRunning: false,
    isStreamingModel: false,
    streamingTools: {},
    readSnapshots: new Map(),
    runCount: 0,
    append: (event) => {
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
