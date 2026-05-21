import type { StoreApi } from "zustand";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import { MAX_EVENTS, reduceStreamEvent } from "@specra/protocol";
import type {
  GlobalSessionEventEnvelope,
  PermissionTerminalEvent,
  QuestionTerminalEvent,
  Reminder,
  SessionEventEnvelope,
  SessionEventPayload,
  SessionMessage,
  SessionProjection,
  SessionStep,
  SessionTodo,
  StreamEvent,
} from "@specra/protocol";
import type { PermissionRequest, QuestionRequest } from "../api/types";

const MAX_IDLE_SESSION_STORES = 20;
const MAX_PENDING_REMOTE_EVENTS = 1000;

export interface WebSessionStoreState extends SessionProjection {
  [key: string]: unknown;
  createdAt: number;
  childSessionIds: Set<string>;
  parentSessionId: string | undefined;
  subAgentDescriptions: Map<string, string>;
  lastTodoWriteStepIndex: number | null;
  lastTodoReminderStepIndex: number | null;
  todoStepReminderCount: number;
  todoLoopContinuationCount: number;
  todoContinuationStagnationCount: number;
  lastTodoContinuationPendingCount: number | null;
  events: SessionEventEnvelope[];
  eventOffset: number;
  nextEventId: number;
  append: (event: SessionEventPayload) => void;
  applyRemoteEnvelope: (envelope: GlobalSessionEventEnvelope) => void;
  pendingPermissions: Map<string, PermissionRequest>;
  pendingQuestions: Map<string, QuestionRequest>;
  addPermissionRequest: (request: PermissionRequest) => void;
  removePermissionRequest: (id: string) => void;
  addQuestionRequest: (request: QuestionRequest) => void;
  removeQuestionRequest: (id: string) => void;
  handlePermissionTerminal: (event: PermissionTerminalEvent) => void;
  handleQuestionTerminal: (event: QuestionTerminalEvent) => void;
  resetTransientState: () => void;
  initializeFromSnapshot: (data: {
    messages?: SessionMessage[];
    steps?: SessionStep[];
    todos?: SessionTodo[];
    reminders?: Reminder[];
    title?: string | null;
    createdAt?: number;
    childSessionIds?: string[];
    parentSessionId?: string;
    subAgentDescriptions?: [string, string][];
    eventCursor?: number;
    events?: SessionEventEnvelope[];
  }) => void;
}

interface RegistryEntry {
  store: StoreApi<WebSessionStoreState>;
  slug: string | undefined;
  sessionId: string;
  lastAccessedAt: number;
  foreground: boolean;
}

const sessionRegistry = new Map<string, RegistryEntry>();
const pendingRemoteEvents = new WeakMap<StoreApi<WebSessionStoreState>, Map<number, GlobalSessionEventEnvelope>>();

function scopedWebKey(slug: string, sessionId: string): string {
  return `${slug}\0${sessionId}`;
}

function webKey(sessionId: string, slug?: string): string {
  return slug === undefined ? sessionId : scopedWebKey(slug, sessionId);
}

function touchRegistryEntry(key: string): void {
  const entry = sessionRegistry.get(key);
  if (entry) entry.lastAccessedAt = Date.now();
}

function appendEnvelopeToState(
  state: WebSessionStoreState,
  envelope: SessionEventEnvelope,
): Partial<WebSessionStoreState> {
  const events = [...state.events, envelope];
  const nextEventId = envelope.id + 1;
  let eventOffset = state.eventOffset;

  if (events.length > MAX_EVENTS) {
    const dropCount = events.length - MAX_EVENTS;
    events.splice(0, dropCount);
    eventOffset += dropCount;
  }

  const payload = envelope.payload;
  if (payload.type === "permission.request") {
    return {
      events,
      eventOffset,
      nextEventId,
      pendingPermissions: new Map(state.pendingPermissions).set(payload.permissionId, {
        id: payload.permissionId,
        sessionId: state.sessionId,
        toolName: payload.toolName,
        toolCallId: "",
        input: payload.args,
        description: payload.description ?? "",
      }),
    };
  }
  if (payload.type === "permission.terminal") {
    const pendingPermissions = new Map(state.pendingPermissions);
    pendingPermissions.delete(payload.permissionId);
    return { events, eventOffset, nextEventId, pendingPermissions };
  }
  if (payload.type === "question.request") {
    return {
      events,
      eventOffset,
      nextEventId,
      pendingQuestions: new Map(state.pendingQuestions).set(payload.questionId, {
        id: payload.questionId,
        sessionId: state.sessionId,
        toolName: "ask_user",
        toolCallId: "",
        questions: [payload.question],
      }),
    };
  }
  if (payload.type === "question.terminal") {
    const pendingQuestions = new Map(state.pendingQuestions);
    pendingQuestions.delete(payload.questionId);
    return { events, eventOffset, nextEventId, pendingQuestions };
  }
  if (payload.type === "shutdown") {
    return { events, eventOffset, nextEventId };
  }

  if (!isReducibleStreamEvent(payload)) {
    return { events, eventOffset, nextEventId };
  }

  const partial = reduceStreamEvent(state, payload, {
    timestamp: envelope.createdAt,
    generateId: () => crypto.randomUUID(),
  });

  return { ...partial, events, eventOffset, nextEventId };
}

function isReducibleStreamEvent(event: SessionEventPayload): event is StreamEvent {
  switch (event.type) {
    case "permission.request":
    case "permission.terminal":
    case "question.request":
    case "question.terminal":
    case "shutdown":
      return false;
    default:
      return true;
  }
}

function toLocalEnvelope(envelope: GlobalSessionEventEnvelope): SessionEventEnvelope {
  return {
    id: envelope.eventId,
    createdAt: envelope.createdAt,
    kind: envelope.kind,
    payload: envelope.payload,
  };
}

function bufferRemoteEnvelope(
  store: StoreApi<WebSessionStoreState>,
  envelope: GlobalSessionEventEnvelope,
): void {
  let buffer = pendingRemoteEvents.get(store);
  if (!buffer) {
    buffer = new Map();
    pendingRemoteEvents.set(store, buffer);
  }
  buffer.set(envelope.eventId, envelope);
  if (buffer.size <= MAX_PENDING_REMOTE_EVENTS) return;

  const oldest = Math.min(...buffer.keys());
  buffer.delete(oldest);
}

function pruneBufferedRemoteEvents(
  store: StoreApi<WebSessionStoreState>,
  minimumEventId: number,
): void {
  const buffer = pendingRemoteEvents.get(store);
  if (!buffer) return;
  for (const eventId of buffer.keys()) {
    if (eventId < minimumEventId) buffer.delete(eventId);
  }
}

function drainBufferedRemoteEvents(store: StoreApi<WebSessionStoreState>): void {
  const buffer = pendingRemoteEvents.get(store);
  if (!buffer) return;

  while (true) {
    const state = store.getState();
    const envelope = buffer.get(state.nextEventId);
    if (!envelope) break;
    buffer.delete(state.nextEventId);
    store.setState((current) => appendEnvelopeToState(current, toLocalEnvelope(envelope)));
  }
}

function isPinned(entry: RegistryEntry): boolean {
  const state = entry.store.getState();
  return (
    entry.foreground ||
    state.isRunning ||
    state.isStreamingModel ||
    state.pendingPermissions.size > 0 ||
    state.pendingQuestions.size > 0
  );
}

export function createWebSessionStore(
  sessionId: string,
  slug?: string,
): StoreApi<WebSessionStoreState> {
  const key = webKey(sessionId, slug);
  const existing = sessionRegistry.get(key);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing.store;
  }

  let store: StoreApi<WebSessionStoreState>;
  store = createStore<WebSessionStoreState>((set) => ({
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
    append: (event: SessionEventPayload) => {
      set((state) => {
        const envelope = {
          id: state.nextEventId,
          createdAt: Date.now(),
          kind: event.type,
          payload: event,
        };
        return appendEnvelopeToState(state, envelope);
      });
      touchRegistryEntry(key);
    },
    applyRemoteEnvelope: (envelope: GlobalSessionEventEnvelope) => {
      if (envelope.slug !== slug || envelope.sessionId !== sessionId) return;
      set((state) => {
        if (envelope.eventId < state.eventOffset) return {};
        if (envelope.eventId < state.nextEventId) return {};
        if (envelope.eventId > state.nextEventId) {
          bufferRemoteEnvelope(store, envelope);
          return {};
        }
        return appendEnvelopeToState(state, toLocalEnvelope(envelope));
      });
      pruneBufferedRemoteEvents(store, store.getState().nextEventId);
      drainBufferedRemoteEvents(store);
      touchRegistryEntry(key);
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
      });
    },
    initializeFromSnapshot: (data) => {
      set((state) => {
        const updates: Partial<WebSessionStoreState> = {};
        if (data.messages !== undefined) {
          updates.messages = data.messages as SessionMessage[];
        }
        if (data.steps !== undefined) {
          updates.steps = data.steps as SessionStep[];
        }
        if (data.todos !== undefined) {
          updates.todos = data.todos as SessionTodo[];
        }
        if (data.reminders !== undefined) {
          updates.reminders = data.reminders as Reminder[];
        }
        if (data.title !== undefined) {
          updates.title = data.title;
        }
        if (data.createdAt !== undefined && data.createdAt > 0) {
          updates.createdAt = data.createdAt;
        }
        if (data.childSessionIds !== undefined) {
          updates.childSessionIds = new Set(data.childSessionIds);
        }
        if (data.parentSessionId !== undefined) {
          updates.parentSessionId = data.parentSessionId;
        }
        if (data.subAgentDescriptions !== undefined) {
          updates.subAgentDescriptions = new Map(data.subAgentDescriptions);
        }
        if (data.events !== undefined) {
          updates.events = data.events;
          updates.nextEventId = data.events.length > 0 ? data.events[data.events.length - 1]!.id + 1 : 0;
          updates.eventOffset = data.events.length > 0 ? data.events[0]!.id : 0;
        } else if (data.eventCursor !== undefined) {
          const nextEventId = data.eventCursor + 1;
          updates.events = [];
          updates.nextEventId = nextEventId;
          updates.eventOffset = Math.max(0, nextEventId - state.events.length);
        }
        return updates;
      });
      pruneBufferedRemoteEvents(store, store.getState().nextEventId);
      drainBufferedRemoteEvents(store);
      touchRegistryEntry(key);
    },
  }));

  sessionRegistry.set(key, {
    store,
    slug,
    sessionId,
    lastAccessedAt: Date.now(),
    foreground: false,
  });
  evictIdleSessionStores();
  return store;
}

export function findWebSessionStore(
  sessionId: string,
  slug?: string,
): StoreApi<WebSessionStoreState> | undefined {
  const entry = sessionRegistry.get(webKey(sessionId, slug));
  if (!entry) return undefined;
  entry.lastAccessedAt = Date.now();
  return entry.store;
}

export function markSessionForeground(slug: string, sessionId: string, foreground: boolean): void {
  const entry = sessionRegistry.get(scopedWebKey(slug, sessionId));
  if (!entry) return;
  entry.foreground = foreground;
  entry.lastAccessedAt = Date.now();
  if (!foreground) evictIdleSessionStores();
}

export function evictIdleSessionStores(): void {
  if (sessionRegistry.size <= MAX_IDLE_SESSION_STORES) return;

  const evictable = Array.from(sessionRegistry.entries())
    .filter(([, entry]) => !isPinned(entry))
    .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);

  for (const [key, entry] of evictable) {
    if (sessionRegistry.size <= MAX_IDLE_SESSION_STORES) break;
    pendingRemoteEvents.delete(entry.store);
    sessionRegistry.delete(key);
  }
}

export function __resetWebSessionStoresForTest(): void {
  sessionRegistry.clear();
}

export function getWebSessionStore(
  sessionId: string,
  slug?: string,
): StoreApi<WebSessionStoreState> {
  return createWebSessionStore(sessionId, slug);
}

export function useSessionStore<T>(
  sessionId: string,
  selector: (state: WebSessionStoreState) => T,
  slug?: string,
): T {
  return useStore(createWebSessionStore(sessionId, slug), selector);
}
