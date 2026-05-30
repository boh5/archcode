import type { ModelMessage } from "ai";
import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { createEmptySessionStats } from "@specra/protocol";
import { toModelMessagesFromStoredMessages } from "./projection";
import { reduceStreamEvent } from "./reduce";
import {
  MAX_EVENTS,
  type SessionEventEnvelope,
  type SessionEventPayload,
  type SessionStoreState,
  type StreamEvent,
} from "./types";

const DEBOUNCE_MS = 25;

export interface ManagedSessionStoreOptions {
  readonly sessionId: string;
  readonly initialState?: Partial<SessionStoreState>;
  readonly persistSession?: (state: SessionStoreState) => void;
  readonly persistInitial?: boolean;
}

export function createManagedSessionStore(options: ManagedSessionStoreOptions): StoreApi<SessionStoreState> {
  let store: StoreApi<SessionStoreState>;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const persist = () => options.persistSession?.(store.getState());
  const schedulePersist = () => {
    if (!options.persistSession) return;
    if (debounceTimer !== undefined) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      persist();
    }, DEBOUNCE_MS);
  };
  const flushPersist = () => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    persist();
  };

  store = createStore<SessionStoreState>((set, get) => ({
    ...createInitialState(options.sessionId),
    ...options.initialState,
    append: (event: SessionEventPayload) => {
      set((state) => {
        const envelope: SessionEventEnvelope = {
          id: state.nextEventId,
          createdAt: Date.now(),
          kind: event.type,
          payload: event,
        };

        const events = [...state.events, envelope];
        let eventOffset = state.eventOffset;
        const nextEventId = state.nextEventId + 1;

        if (events.length > MAX_EVENTS) {
          const dropCount = events.length - MAX_EVENTS;
          events.splice(0, dropCount);
          eventOffset += dropCount;
        }

        const partial = reduceStreamEvent(state, event as StreamEvent);

        return { ...partial, events, eventOffset, nextEventId };
      });

      if (event.type === "run-end") flushPersist();
      else if (shouldPersistAppend(event)) schedulePersist();
    },
    setTitle: (title: string | null) => {
      set({ title });
      flushPersist();
    },
    setParentSessionId: (parentSessionId: string | undefined) => {
      set({ parentSessionId });
      flushPersist();
    },
    linkChildSession: (childSessionId: string, description?: string) => {
      set((state) => {
        const childSessionIds = new Set(state.childSessionIds);
        childSessionIds.add(childSessionId);

        const subAgentDescriptions = new Map(state.subAgentDescriptions);
        if (description !== undefined) subAgentDescriptions.set(childSessionId, description);

        return { childSessionIds, subAgentDescriptions };
      });
      flushPersist();
    },
    toModelMessages: (): ModelMessage[] =>
      toModelMessagesFromStoredMessages(get().messages),
  }));

  if (options.persistInitial) flushPersist();
  return store;
}

function createInitialState(sessionId: string): Omit<SessionStoreState, "append" | "setTitle" | "setParentSessionId" | "linkChildSession" | "toModelMessages"> {
  return {
    sessionId,
    createdAt: Date.now(),
    title: null,
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    runs: [],
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
    lastExtractionIndex: 0,
    lastExtractionTime: 0,
    events: [],
    eventOffset: 0,
    nextEventId: 0,
  };
}

function shouldPersistAppend(event: SessionEventPayload): boolean {
  switch (event.type) {
    case "run-start":
    case "user-message":
    case "text-end":
    case "reasoning-end":
    case "tool-call":
    case "tool-result":
    case "todo-write":
    case "reminder":
    case "reminder-consumed":
    case "step-start":
    case "step-end":
    case "loop-error":
    case "compact":
      return true;
    default:
      return false;
  }
}
