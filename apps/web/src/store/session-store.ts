import type { StoreApi } from "zustand";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import { MAX_EVENTS, createEmptySessionStats, isStreamEvent, reduceStreamEvent } from "@archcode/protocol";
import type {
  CompressionStateSnapshot,
  GlobalSessionEventEnvelope,
  Reminder,
  ToolChildSessionLink,
  SessionEventEnvelope,
  SessionEventPayload,
  SessionMessage,
  PendingSessionMessage,
  ExecutionModelBindingSummary,
  RequestedModelSelection,
  SessionModelSelection,
  SessionNextModelSelection,
  SessionProjection,
  SessionExecutionRecord,
  SessionExecutionInputCheckpoint,
  SessionStats,
  SessionStep,
  SessionTodo,
  SessionGoal,
} from "@archcode/protocol";
import { createClientUuid } from "../lib/client-uuid";

const MAX_IDLE_SESSION_STORES = 20;
const MAX_PENDING_REMOTE_EVENTS = 1000;

export interface WebSessionStoreState extends Omit<SessionProjection, "cwd" | "agentName"> {
  [key: string]: unknown;
  hydrationStatus: "pending" | "hydrated";
  /** Source-window-only optimistic projection. It is replaced by durable message events. */
  localSendingMessages: Array<{
    clientRequestId: string;
    content: string;
    createdAt: number;
    status: "sending" | "retryable";
    requestedModelSelection: RequestedModelSelection;
  }>;
  createdAt: number;
  cwd: string | null;
  rootSessionId: string;
  parentSessionId: string | undefined;
  agentName: string | null;
  nextModelSelection: SessionNextModelSelection | undefined;
  activeModelBinding: ExecutionModelBindingSummary | undefined;
  focusSessionId: string | null;
  lastTodoWriteStepIndex: number | null;
  lastTodoReminderStepIndex: number | null;
  todoStepReminderCount: number;
  todoLoopContinuationCount: number;
  todoContinuationStagnationCount: number;
  lastTodoContinuationPendingCount: number | null;
  events: SessionEventEnvelope[];
  eventOffset: number;
  nextEventId: number;
  setFocusSessionId: (id: string | null) => void;
  append: (event: SessionEventPayload) => void;
  addLocalSendingMessage: (input: { clientRequestId: string; content: string; requestedModelSelection: RequestedModelSelection; createdAt?: number }) => void;
  setLocalSendingMessageStatus: (clientRequestId: string, status: "sending" | "retryable") => void;
  removeLocalSendingMessage: (clientRequestId: string) => void;
  reconcileLocalSendingMessage: (clientRequestId: string) => void;
  applyRemoteEnvelope: (envelope: GlobalSessionEventEnvelope) => void;
  resetTransientState: () => void;
  initializeFromSnapshot: (data: {
    messages?: SessionMessage[];
    pendingMessages?: PendingSessionMessage[];
    steps?: SessionStep[];
    todos?: SessionTodo[];
    reminders?: Reminder[];
    childSessionLinks?: ToolChildSessionLink[];
    title?: string | null;
    createdAt?: number;
    cwd?: string;
    rootSessionId?: string;
    parentSessionId?: string;
    agentName?: string | null;
    stats?: SessionStats;
    executions?: SessionExecutionRecord[];
    executionInputCheckpoints?: SessionExecutionInputCheckpoint[];
    eventCursor?: number;
    events?: SessionEventEnvelope[];
    modelSelection?: SessionModelSelection;
    nextModelSelection?: SessionNextModelSelection;
    activeModelBinding?: ExecutionModelBindingSummary;
    compression?: CompressionStateSnapshot;
    /** `undefined` is a legitimate clear from the authoritative Session snapshot. */
    goal?: SessionGoal | undefined;
  }) => void;
}

interface SessionRegistryEntry {
  store: StoreApi<WebSessionStoreState>;
  slug: string | undefined;
  sessionId: string;
  lastAccessedAt: number;
  foreground: boolean;
}

const sessionRegistry = new Map<string, SessionRegistryEntry>();
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

  if (envelope.payload.type === "shutdown") {
    return { events, eventOffset, nextEventId };
  }

  if (!isStreamEvent(envelope.payload)) {
    return { events, eventOffset, nextEventId };
  }

  const partial = reduceStreamEvent(state as SessionProjection, envelope.payload, {
    timestamp: envelope.createdAt,
    generateId: createClientUuid,
  });

  // A durable queued/canonical message carries the same clientRequestId as the
  // source-window optimistic bubble. Reconcile it here instead of rendering a
  // second copy.
  const durableMessages = partial.messages ?? state.messages;
  const durableRequestIds = new Set(durableMessages.map((message) => message.clientRequestId));
  const durablePendingMessages = (partial.pendingMessages ?? state.pendingMessages) as PendingSessionMessage[];
  for (const message of durablePendingMessages) durableRequestIds.add(message.clientRequestId);
  const localSendingMessages = state.localSendingMessages.filter(
    (message) => !durableRequestIds.has(message.clientRequestId),
  );

  const modelBindingUpdates = envelope.payload.type === "execution-start"
    ? { activeModelBinding: envelope.payload.binding }
    : envelope.payload.type === "execution-end"
      ? { activeModelBinding: undefined }
      : envelope.payload.type === "session.model_selection_changed"
        ? { nextModelSelection: undefined }
        : {};

  return { ...partial, ...modelBindingUpdates, localSendingMessages, events, eventOffset, nextEventId };
}

function toLocalEnvelope(envelope: GlobalSessionEventEnvelope): SessionEventEnvelope {
  return {
    id: envelope.eventId,
    createdAt: envelope.createdAt,
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
    store.setState((current) => {
      const updates = appendEnvelopeToState(current, toLocalEnvelope(envelope));
      if (envelope.agentName && current.agentName !== envelope.agentName) {
        updates.agentName = envelope.agentName;
      }
      return updates;
    });
  }
}

function isPinned(entry: SessionRegistryEntry): boolean {
  const state = entry.store.getState();
  return (
    entry.foreground ||
    state.isRunning ||
    state.isStreamingModel
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
    hydrationStatus: "pending",
    createdAt: Date.now(),
    cwd: null,
    title: null,
    modelSelection: { revision: 0 },
    nextModelSelection: undefined,
    activeModelBinding: undefined,
    agentName: null,
    messages: [],
    pendingMessages: [],
    localSendingMessages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    executionInputCheckpoints: [],
    todos: [],
    reminders: [],
    childSessionLinks: [],
    compression: undefined,
    compressionBlocks: [],
    // Mirrors persisted identity; tree relationships come from session-tree responses.
    rootSessionId: sessionId,
    parentSessionId: undefined,
    isRunning: false,
    isStreamingModel: false,
    readSnapshots: new Map(),
    executionCount: 0,
    focusSessionId: null,
    lastTodoWriteStepIndex: null,
    lastTodoReminderStepIndex: null,
    todoStepReminderCount: 0,
    todoLoopContinuationCount: 0,
    todoContinuationStagnationCount: 0,
    lastTodoContinuationPendingCount: null,
    events: [],
    eventOffset: 0,
    nextEventId: 0,
    setFocusSessionId: (id: string | null) => set({ focusSessionId: id }),
    append: (event: SessionEventPayload) => {
      set((state) => {
        const envelope = {
          id: state.nextEventId,
          createdAt: Date.now(),
          payload: event,
        };
        return appendEnvelopeToState(state, envelope);
      });
      touchRegistryEntry(key);
    },
    addLocalSendingMessage: ({ clientRequestId, content, requestedModelSelection, createdAt = Date.now() }) => {
      set((state) => state.localSendingMessages.some((item) => item.clientRequestId === clientRequestId)
        ? {}
        : { localSendingMessages: [...state.localSendingMessages, { clientRequestId, content, requestedModelSelection, createdAt, status: "sending" }] });
      touchRegistryEntry(key);
    },
    setLocalSendingMessageStatus: (clientRequestId, status) => {
      set((state) => ({
        localSendingMessages: state.localSendingMessages.map((item) => (
          item.clientRequestId === clientRequestId ? { ...item, status } : item
        )),
      }));
    },
    removeLocalSendingMessage: (clientRequestId) => {
      set((state) => ({
        localSendingMessages: state.localSendingMessages.filter((item) => item.clientRequestId !== clientRequestId),
      }));
    },
    reconcileLocalSendingMessage: (clientRequestId) => {
      set((state) => ({
        localSendingMessages: state.localSendingMessages.filter((item) => item.clientRequestId !== clientRequestId),
      }));
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
        const updates = appendEnvelopeToState(state, toLocalEnvelope(envelope));
        if (envelope.agentName && state.agentName !== envelope.agentName) {
          updates.agentName = envelope.agentName;
        }
        return updates;
      });
      pruneBufferedRemoteEvents(store, store.getState().nextEventId);
      drainBufferedRemoteEvents(store);
      touchRegistryEntry(key);
    },
    toModelMessages: () => [],
    resetTransientState: () => {},
    initializeFromSnapshot: (data) => {
      set((state) => {
        const snapshotNextEventId = data.eventCursor !== undefined ? data.eventCursor + 1 : (data.events && data.events.length > 0 ? data.events[data.events.length - 1]!.id + 1 : 0);
        // If SSE has already processed events beyond the snapshot, keep local
        // reducer-managed state (messages, steps, etc.) and only update scalar
        // metadata fields (title, createdAt, etc.) that don't lose information
        // from missing SSE events like tool-input-resolved.
        const stale = state.nextEventId > snapshotNextEventId;

        const updates: Partial<WebSessionStoreState> = {};
        if (data.messages !== undefined && !stale) {
          updates.messages = data.messages as SessionMessage[];
        }
        if (data.pendingMessages !== undefined && !stale) {
          updates.pendingMessages = data.pendingMessages as PendingSessionMessage[];
        }
        if (data.steps !== undefined && !stale) {
          updates.steps = data.steps as SessionStep[];
        }
        if (data.todos !== undefined) {
          updates.todos = data.todos as SessionTodo[];
        }
        if (data.reminders !== undefined && !stale) {
          updates.reminders = data.reminders as Reminder[];
        }
        if (data.childSessionLinks !== undefined && !stale) {
          updates.childSessionLinks = data.childSessionLinks;
        }
        if (data.title !== undefined) {
          updates.title = data.title;
        }
        if (data.createdAt !== undefined && data.createdAt > 0) {
          updates.createdAt = data.createdAt;
        }
        if (data.cwd !== undefined && (!stale || state.cwd === null)) {
          updates.cwd = data.cwd;
          updates.hydrationStatus = "hydrated";
        }
        if (data.stats !== undefined && !stale) {
          updates.stats = data.stats;
        }
        if (data.executions !== undefined && !stale) {
          updates.executions = data.executions;
        }
        if (data.executionInputCheckpoints !== undefined && !stale) {
          updates.executionInputCheckpoints = data.executionInputCheckpoints;
        }
        if (data.rootSessionId !== undefined) {
          updates.rootSessionId = data.rootSessionId;
        }
        if (data.parentSessionId !== undefined) {
          updates.parentSessionId = data.parentSessionId;
        }
        if (data.agentName !== undefined) {
          updates.agentName = data.agentName;
        }
        if (data.modelSelection !== undefined && !stale) {
          updates.modelSelection = data.modelSelection;
        }
        if (data.nextModelSelection !== undefined && !stale) {
          updates.nextModelSelection = data.nextModelSelection;
        }
        if ("activeModelBinding" in data && !stale) {
          updates.activeModelBinding = data.activeModelBinding;
        }
        if (data.compression !== undefined && !stale) {
          updates.compression = data.compression;
        }
        if ("goal" in data && !stale) {
          updates.goal = data.goal;
        }
        if (data.events !== undefined && !stale) {
          updates.events = data.events;
          updates.nextEventId = data.events.length > 0 ? data.events[data.events.length - 1]!.id + 1 : 0;
          updates.eventOffset = data.events.length > 0 ? data.events[0]!.id : 0;
        } else if (data.eventCursor !== undefined && !stale) {
          const nextEventId = data.eventCursor + 1;
          updates.events = [];
          updates.nextEventId = nextEventId;
          updates.eventOffset = Math.max(0, nextEventId - state.events.length);
        }
        if (!stale && (data.messages !== undefined || data.pendingMessages !== undefined)) {
          const durableRequestIds = new Set<string>();
          for (const message of data.messages ?? state.messages) {
            if (message.clientRequestId) durableRequestIds.add(message.clientRequestId);
          }
          for (const message of data.pendingMessages ?? state.pendingMessages) {
            durableRequestIds.add(message.clientRequestId);
          }
          updates.localSendingMessages = state.localSendingMessages.filter(
            (message) => !durableRequestIds.has(message.clientRequestId),
          );
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
