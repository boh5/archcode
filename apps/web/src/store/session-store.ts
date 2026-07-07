import type { StoreApi } from "zustand";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import { MAX_EVENTS, createEmptySessionStats, reduceStreamEvent } from "@archcode/protocol";
import type {
  CompressionBlockPart,
  CompressionStateSnapshot,
  GlobalSessionEventEnvelope,
  Reminder,
  ToolChildSessionLink,
  SessionEventEnvelope,
  SessionEventPayload,
  SessionMessage,
  SessionModelInfo,
  SessionProjection,
  SessionExecutionRecord,
  SessionStats,
  SessionStep,
  SessionTodo,
  StreamEvent,
} from "@archcode/protocol";

const MAX_IDLE_SESSION_STORES = 20;
const MAX_PENDING_REMOTE_EVENTS = 1000;

export interface WebSessionStoreState extends SessionProjection {
  [key: string]: unknown;
  createdAt: number;
  rootSessionId: string;
  parentSessionId: string | undefined;
  agentName: string;
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
  applyRemoteEnvelope: (envelope: GlobalSessionEventEnvelope) => void;
  resetTransientState: () => void;
  initializeFromSnapshot: (data: {
    messages?: SessionMessage[];
    steps?: SessionStep[];
    todos?: SessionTodo[];
    reminders?: Reminder[];
    childSessionLinks?: ToolChildSessionLink[];
    title?: string | null;
    createdAt?: number;
    rootSessionId?: string;
    parentSessionId?: string;
    agentName?: string;
    stats?: SessionStats;
    executions?: SessionExecutionRecord[];
    eventCursor?: number;
    events?: SessionEventEnvelope[];
    modelInfo?: SessionModelInfo | null;
    compression?: CompressionStateSnapshot;
    compressionBlocks?: CompressionBlockPart[];
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

  if (envelope.payload.type === "shutdown") {
    return { events, eventOffset, nextEventId };
  }

  if (!isReducibleStreamEvent(envelope.payload)) {
    return { events, eventOffset, nextEventId };
  }

  const partial = reduceStreamEvent(state, envelope.payload, {
    timestamp: envelope.createdAt,
    generateId: () => crypto.randomUUID(),
  });

  return { ...partial, events, eventOffset, nextEventId };
}

function isReducibleStreamEvent(event: SessionEventPayload): event is StreamEvent {
  switch (event.type) {
    case "execution-start":
    case "execution-end":
    case "user-message":
    case "system-notice":
    case "text-start":
    case "text-delta":
    case "text-end":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "tool-input-start":
    case "tool-call":
    case "tool-input-resolved":
    case "tool-attempt":
    case "tool-result":
    case "tool-child-session-link":
    case "todo-write":
    case "reminder":
    case "reminder-consumed":
    case "step-start":
    case "step-end":
    case "loop-error":
    case "llm-retry":
    case "llm-recovery":
    case "llm-recovery-failed":
    case "compact":
    case "compression.block_committed":
    case "compression.block_failed":
    case "compression.ref_map_updated":
    case "goal.state_change":
    case "goal.done_check":
    case "goal.escalation":
    case "hitl.request":
    case "hitl.resolved":
      return true;
    default:
      return false;
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
    store.setState((current) => {
      const updates = appendEnvelopeToState(current, toLocalEnvelope(envelope));
      if (envelope.agentName && current.agentName !== envelope.agentName) {
        updates.agentName = envelope.agentName;
      }
      return updates;
    });
  }
}

function isPinned(entry: RegistryEntry): boolean {
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
    createdAt: Date.now(),
    title: null,
    modelInfo: null,
    agentName: "orchestrator",
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
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
        const stale = snapshotNextEventId > 0 && state.nextEventId > snapshotNextEventId;

        const updates: Partial<WebSessionStoreState> = {};
        if (data.messages !== undefined && !stale) {
          updates.messages = data.messages as SessionMessage[];
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
        if (data.stats !== undefined && !stale) {
          updates.stats = data.stats;
        }
        if (data.executions !== undefined && !stale) {
          updates.executions = data.executions;
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
        if (data.modelInfo !== undefined) {
          updates.modelInfo = data.modelInfo;
        }
        if (data.compression !== undefined && !stale) {
          updates.compression = data.compression;
        }
        if (data.compressionBlocks !== undefined && !stale) {
          updates.compressionBlocks = data.compressionBlocks;
        }
        if (data.events !== undefined) {
          updates.events = data.events;
          updates.nextEventId = data.events.length > 0 ? data.events[data.events.length - 1]!.id + 1 : 0;
          updates.eventOffset = data.events.length > 0 ? data.events[0]!.id : 0;
        } else if (data.eventCursor !== undefined && !stale) {
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
