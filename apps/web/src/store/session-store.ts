import type { StoreApi } from "zustand";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import {
  MAX_EVENTS,
  createEmptySessionStats,
  isStreamEvent,
  reduceStreamEvent,
  validateExecutionTransition,
} from "@archcode/protocol";
import type {
  CompressionStateSnapshot,
  GlobalSessionEventEnvelope,
  SessionEventEnvelope,
  SessionEventPayload,
  Session as ProtocolSession,
  PendingSessionMessage,
  ExecutionModelBindingSummary,
  RequestedModelSelection,
  SessionModelState,
  SessionNextModelSelection,
  SessionProjection,
  ExecutionLifecycleEvent,
  AttachmentDescriptor,
} from "@archcode/protocol";
import { createClientUuid } from "../lib/client-uuid";

const MAX_IDLE_SESSION_STORES = 20;
const MAX_PENDING_REMOTE_EVENTS = 1000;

export type SessionSnapshotApplyResult =
  | "applied"
  | "ignored"
  | "stale-generation"
  | "refresh-required";
export type RemoteEnvelopeApplyResult =
  | "applied"
  | "duplicate"
  | "ignored"
  | "gap"
  | "invalid"
  | "refresh-required";
export type GlobalSessionDeltaEnvelope = GlobalSessionEventEnvelope & {
  payload: Extract<SessionEventPayload, { type: "text-delta" | "reasoning-delta" }>;
};

export interface SessionMetadataPatch {
  title?: string | null;
  createdAt?: number;
  rootSessionId?: string;
  parentSessionId?: string;
  agentName?: string | null;
}

export type SessionAuthoritativeSnapshot =
  & ProtocolSession
  & Pick<SessionProjection, "compression">;

export interface WebSessionStoreState extends Omit<SessionProjection, "cwd" | "agentName"> {
  [key: string]: unknown;
  hydrationStatus: "pending" | "hydrated";
  /** Source-window-only optimistic projection. It is replaced by durable message events. */
  localSendingMessages: Array<{
    clientRequestId: string;
    content: string;
    attachments: AttachmentDescriptor[];
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
  snapshotRecoveryStatus: "live" | "awaiting";
  snapshotRecoveryGeneration: number;
  setFocusSessionId: (id: string | null) => void;
  append: (event: SessionEventPayload) => void;
  addLocalSendingMessage: (input: {
    clientRequestId: string;
    content: string;
    attachments: AttachmentDescriptor[];
    requestedModelSelection: RequestedModelSelection;
    createdAt?: number;
  }) => void;
  setLocalSendingMessageStatus: (
    clientRequestId: string,
    status: "sending" | "retryable",
  ) => void;
  removeLocalSendingMessage: (clientRequestId: string) => void;
  reconcileLocalSendingMessage: (clientRequestId: string) => void;
  applyRemoteEnvelope: (envelope: GlobalSessionEventEnvelope) => RemoteEnvelopeApplyResult;
  applyRemoteDeltaBatch: (
    envelopes: readonly GlobalSessionDeltaEnvelope[],
  ) => RemoteEnvelopeApplyResult;
  beginSnapshotRecovery: (generation: number) => void;
  applyMetadataPatch: (patch: SessionMetadataPatch) => void;
  applyModelStatePatch: (patch: SessionModelState) => void;
  applyAuthoritativeSnapshot: (
    data: SessionAuthoritativeSnapshot,
    generation: number,
  ) => SessionSnapshotApplyResult;
  resetTransientState: () => void;
}

interface SessionRegistryEntry {
  store: StoreApi<WebSessionStoreState>;
  slug: string | undefined;
  sessionId: string;
  lastAccessedAt: number;
  foreground: boolean;
}

const sessionRegistry = new Map<string, SessionRegistryEntry>();
interface BufferedRemoteEnvelope {
  generation: number;
  envelope: GlobalSessionEventEnvelope;
}
const pendingRemoteEvents = new WeakMap<StoreApi<WebSessionStoreState>, Map<number, BufferedRemoteEnvelope>>();
let sessionSnapshotGeneration = 0;

export function currentSessionSnapshotGeneration(): number {
  return sessionSnapshotGeneration;
}

export function beginSessionSnapshotRecovery(): number {
  sessionSnapshotGeneration += 1;
  for (const entry of sessionRegistry.values()) {
    entry.store.getState().beginSnapshotRecovery(sessionSnapshotGeneration);
  }
  return sessionSnapshotGeneration;
}

function scopedWebKey(slug: string, sessionId: string): string {
  return `${slug}\0${sessionId}`;
}

function webKey(sessionId: string, slug?: string): string {
  return slug === undefined ? sessionId : scopedWebKey(slug, sessionId);
}

function runtimeStateFromSnapshot(input: {
  executionCount: number;
  isRunning: boolean;
  isStreamingModel: boolean;
  currentExecutionId: string | undefined;
  currentAssistantMessageId: string | undefined;
}): Pick<
  WebSessionStoreState,
  | "currentAssistantMessageId"
  | "currentExecutionId"
  | "executionCount"
  | "isRunning"
  | "isStreamingModel"
> {
  return {
    currentExecutionId: input.currentExecutionId,
    currentAssistantMessageId: input.currentAssistantMessageId,
    executionCount: input.executionCount,
    isRunning: input.isRunning,
    isStreamingModel: input.isStreamingModel,
  };
}

function touchRegistryEntry(key: string): void {
  const entry = sessionRegistry.get(key);
  if (entry) entry.lastAccessedAt = Date.now();
}

function appendEnvelopeToState(
  state: WebSessionStoreState,
  envelope: SessionEventEnvelope,
  applyPayload = true,
): Partial<WebSessionStoreState> {
  const events = [...state.events, envelope];
  const nextEventId = envelope.id + 1;
  let eventOffset = state.eventOffset;

  if (events.length > MAX_EVENTS) {
    const dropCount = events.length - MAX_EVENTS;
    events.splice(0, dropCount);
    eventOffset += dropCount;
  }

  if (!applyPayload || envelope.payload.type === "shutdown") {
    return { events, eventOffset, nextEventId };
  }

  if (!isStreamEvent(envelope.payload)) {
    return { events, eventOffset, nextEventId };
  }

  const partial = reduceStreamEvent(
    state as SessionProjection,
    envelope.payload,
    {
      timestamp: envelope.createdAt,
      generateId: createClientUuid,
    },
  );

  // A durable queued/canonical message carries the same clientRequestId as the
  // source-window optimistic bubble. Reconcile it here instead of rendering a
  // second copy.
  const durableMessages = partial.messages ?? state.messages;
  const durableRequestIds = new Set(
    durableMessages.map((message) => message.clientRequestId),
  );
  const durablePendingMessages = (partial.pendingMessages ??
    state.pendingMessages) as PendingSessionMessage[];
  for (const message of durablePendingMessages)
    durableRequestIds.add(message.clientRequestId);
  const localSendingMessages = state.localSendingMessages.filter(
    (message) => !durableRequestIds.has(message.clientRequestId),
  );

  const modelBindingUpdates =
    envelope.payload.type === "execution-start" ||
    envelope.payload.type === "execution-resumed"
      ? { activeModelBinding: envelope.payload.binding }
      : envelope.payload.type === "execution-end"
        ? { activeModelBinding: undefined }
        : envelope.payload.type === "session.model_selection_changed"
          ? { nextModelSelection: undefined }
          : {};

  return {
    ...partial,
    ...modelBindingUpdates,
    localSendingMessages,
    events,
    eventOffset,
    nextEventId,
  };
}

function executionLifecycleEvent(
  payload: SessionEventPayload,
): ExecutionLifecycleEvent | undefined {
  switch (payload.type) {
    case "execution-start":
    case "execution-suspended":
    case "execution-suspension-updated":
    case "execution-resumed":
    case "execution-end":
      return payload;
    default:
      return undefined;
  }
}

function applyContiguousRemoteEnvelope(
  store: StoreApi<WebSessionStoreState>,
  envelope: GlobalSessionEventEnvelope,
): RemoteEnvelopeApplyResult {
  let outcome: RemoteEnvelopeApplyResult = "applied";
  store.setState((state) => {
    const lifecycleEvent = executionLifecycleEvent(envelope.payload);
    const transition = lifecycleEvent === undefined
      ? undefined
      : validateExecutionTransition(state.executions, lifecycleEvent);
    if (transition?.outcome === "invalid") {
      outcome = "invalid";
      return {};
    }

    outcome = transition?.outcome === "duplicate" ? "duplicate" : "applied";
    const updates = appendEnvelopeToState(
      state,
      toLocalEnvelope(envelope),
      outcome === "applied",
    );
    if (
      outcome === "applied" &&
      envelope.agentName &&
      state.agentName !== envelope.agentName
    ) {
      updates.agentName = envelope.agentName;
    }
    return updates;
  });
  return outcome;
}

function applyContiguousRemoteDeltaBatch(
  store: StoreApi<WebSessionStoreState>,
  envelopes: readonly GlobalSessionDeltaEnvelope[],
): RemoteEnvelopeApplyResult {
  let outcome: RemoteEnvelopeApplyResult = "ignored";
  store.setState((state) => {
    let expectedEventId = state.nextEventId;
    const contiguous: GlobalSessionDeltaEnvelope[] = [];
    for (const envelope of envelopes) {
      if (envelope.eventId < expectedEventId) continue;
      if (envelope.eventId > expectedEventId) {
        outcome = "gap";
        return {};
      }
      contiguous.push(envelope);
      expectedEventId += 1;
    }
    if (contiguous.length === 0) return {};

    let nextState = state;
    for (const envelope of contiguous) {
      const updates = appendEnvelopeToState(nextState, toLocalEnvelope(envelope));
      if (envelope.agentName && nextState.agentName !== envelope.agentName) {
        updates.agentName = envelope.agentName;
      }
      nextState = { ...nextState, ...updates };
    }

    outcome = "applied";
    return nextState;
  });
  return outcome;
}

function toLocalEnvelope(
  envelope: GlobalSessionEventEnvelope,
): SessionEventEnvelope {
  return {
    id: envelope.eventId,
    createdAt: envelope.createdAt,
    payload: envelope.payload,
  };
}

function bufferRemoteEnvelope(
  store: StoreApi<WebSessionStoreState>,
  envelope: GlobalSessionEventEnvelope,
  generation: number,
): boolean {
  let buffer = pendingRemoteEvents.get(store);
  if (!buffer) {
    buffer = new Map();
    pendingRemoteEvents.set(store, buffer);
  }
  buffer.set(envelope.eventId, { generation, envelope });
  if (buffer.size <= MAX_PENDING_REMOTE_EVENTS) return true;
  buffer.clear();
  return false;
}

function discardBufferedRemoteEventsThrough(
  store: StoreApi<WebSessionStoreState>,
  maximumEventId: number,
): void {
  const buffer = pendingRemoteEvents.get(store);
  if (!buffer) return;
  for (const eventId of buffer.keys()) {
    if (eventId <= maximumEventId) buffer.delete(eventId);
  }
}

function drainRecoveryBuffer(
  store: StoreApi<WebSessionStoreState>,
  generation: number,
): boolean {
  const buffer = pendingRemoteEvents.get(store);
  if (!buffer || buffer.size === 0) return true;

  for (const [eventId, item] of buffer) {
    if (item.generation !== generation) buffer.delete(eventId);
  }

  if (buffer.size === 0) return true;
  const eventIds = [...buffer.keys()].sort((left, right) => left - right);
  let expectedEventId = store.getState().nextEventId;
  for (const eventId of eventIds) {
    if (eventId !== expectedEventId) {
      buffer.clear();
      return false;
    }
    expectedEventId += 1;
  }

  while (true) {
    const state = store.getState();
    const item = buffer.get(state.nextEventId);
    if (!item) break;
    buffer.delete(state.nextEventId);
    const outcome = applyContiguousRemoteEnvelope(store, item.envelope);
    if (outcome === "invalid") {
      buffer.clear();
      return false;
    }
  }
  return buffer.size === 0;
}

function isPinned(entry: SessionRegistryEntry): boolean {
  const state = entry.store.getState();
  return entry.foreground || state.isRunning || state.isStreamingModel;
}

function metadataPatchUpdates(
  state: WebSessionStoreState,
  patch: SessionMetadataPatch,
): Partial<WebSessionStoreState> {
  const updates: Partial<WebSessionStoreState> = {};
  if ("title" in patch) updates.title = patch.title ?? null;
  if (patch.createdAt !== undefined && patch.createdAt > 0) updates.createdAt = patch.createdAt;
  if (patch.rootSessionId !== undefined) updates.rootSessionId = patch.rootSessionId;
  if ("parentSessionId" in patch) updates.parentSessionId = patch.parentSessionId;
  if ("agentName" in patch) updates.agentName = patch.agentName ?? null;
  return updates;
}

function authoritativeSnapshotUpdates(
  state: WebSessionStoreState,
  data: SessionAuthoritativeSnapshot,
  replaceReducerProjection: boolean,
): Partial<WebSessionStoreState> {
  const updates = metadataPatchUpdates(state, data);
  if (replaceReducerProjection || state.cwd === null) {
    updates.cwd = data.cwd;
    updates.hydrationStatus = "hydrated";
  }

  if (!replaceReducerProjection) return updates;

  updates.messages = data.messages;
  updates.pendingMessages = data.pendingMessages;
  updates.steps = data.steps;
  updates.todos = data.todos;
  updates.reminders = data.reminders;
  updates.childSessionLinks = data.childSessionLinks;
  updates.parentSessionId = data.parentSessionId;
  updates.stats = data.stats;
  updates.executions = data.executions;
  Object.assign(updates, runtimeStateFromSnapshot({
    executionCount: data.executionCount,
    isRunning: data.isRunning,
    isStreamingModel: data.isStreamingModel,
    currentExecutionId: data.currentExecutionId,
    currentAssistantMessageId: data.currentAssistantMessageId,
  }));
  updates.modelSelection = data.modelSelection;
  updates.nextModelSelection = data.nextModelSelection;
  updates.activeModelBinding = data.activeModelBinding;
  updates.compression = data.compression;
  updates.goal = data.goal;

  const nextEventId = data.eventCursor + 1;
  updates.events = [];
  updates.nextEventId = nextEventId;
  updates.eventOffset = nextEventId;

  const durableRequestIds = new Set<string>();
  for (const message of data.messages) {
    if (message.clientRequestId) durableRequestIds.add(message.clientRequestId);
  }
  for (const message of data.pendingMessages) durableRequestIds.add(message.clientRequestId);
  updates.localSendingMessages = state.localSendingMessages.filter(
    (message) => !durableRequestIds.has(message.clientRequestId),
  );

  return updates;
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
  const applyRemoteDeltaBatch = (
    envelopes: readonly GlobalSessionDeltaEnvelope[],
  ): RemoteEnvelopeApplyResult => {
    if (envelopes.length === 0) return "ignored";
    if (envelopes.some((envelope) => envelope.slug !== slug || envelope.sessionId !== sessionId)) {
      return "ignored";
    }

    const state = store.getState();
    if (state.snapshotRecoveryStatus === "awaiting") {
      const buffered = envelopes.every((envelope) => bufferRemoteEnvelope(
        store,
        envelope,
        state.snapshotRecoveryGeneration,
      ));
      touchRegistryEntry(key);
      return buffered ? "ignored" : "refresh-required";
    }

    const result = applyContiguousRemoteDeltaBatch(store, envelopes);
    touchRegistryEntry(key);
    return result;
  };

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
    snapshotRecoveryStatus: sessionSnapshotGeneration === 0 ? "live" : "awaiting",
    snapshotRecoveryGeneration: sessionSnapshotGeneration,
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
    addLocalSendingMessage: ({
      clientRequestId,
      content,
      attachments,
      requestedModelSelection,
      createdAt = Date.now(),
    }) => {
      set((state) =>
        state.localSendingMessages.some(
          (item) => item.clientRequestId === clientRequestId,
        )
          ? {}
          : {
              localSendingMessages: [
                ...state.localSendingMessages,
                {
                  clientRequestId,
                  content,
                  attachments,
                  requestedModelSelection,
                  createdAt,
                  status: "sending",
                },
              ],
            },
      );
      touchRegistryEntry(key);
    },
    setLocalSendingMessageStatus: (clientRequestId, status) => {
      set((state) => ({
        localSendingMessages: state.localSendingMessages.map((item) =>
          item.clientRequestId === clientRequestId ? { ...item, status } : item,
        ),
      }));
    },
    removeLocalSendingMessage: (clientRequestId) => {
      set((state) => ({
        localSendingMessages: state.localSendingMessages.filter(
          (item) => item.clientRequestId !== clientRequestId,
        ),
      }));
    },
    reconcileLocalSendingMessage: (clientRequestId) => {
      set((state) => ({
        localSendingMessages: state.localSendingMessages.filter(
          (item) => item.clientRequestId !== clientRequestId,
        ),
      }));
    },
    applyRemoteEnvelope: (envelope: GlobalSessionEventEnvelope) => {
      if (envelope.slug !== slug || envelope.sessionId !== sessionId) return "ignored";
      const state = store.getState();
      if (state.snapshotRecoveryStatus === "awaiting") {
        const result = bufferRemoteEnvelope(
          store,
          envelope,
          state.snapshotRecoveryGeneration,
        ) ? "ignored" : "refresh-required";
        touchRegistryEntry(key);
        return result;
      }
      if (envelope.eventId < state.nextEventId) return "ignored";
      if (envelope.eventId > state.nextEventId) return "gap";
      const result = applyContiguousRemoteEnvelope(store, envelope);
      touchRegistryEntry(key);
      return result;
    },
    applyRemoteDeltaBatch,
    beginSnapshotRecovery: (generation) => {
      pendingRemoteEvents.delete(store);
      set({
        snapshotRecoveryStatus: "awaiting",
        snapshotRecoveryGeneration: generation,
      });
      touchRegistryEntry(key);
    },
    applyMetadataPatch: (patch) => {
      set((state) => metadataPatchUpdates(state, patch));
      touchRegistryEntry(key);
    },
    applyModelStatePatch: (patch) => {
      set((state) => patch.modelSelection.revision < state.modelSelection.revision
        ? {}
        : {
            modelSelection: patch.modelSelection,
            nextModelSelection: patch.nextModelSelection,
            activeModelBinding: patch.activeModelBinding,
          });
      touchRegistryEntry(key);
    },
    toModelMessages: () => [],
    resetTransientState: () => {},
    applyAuthoritativeSnapshot: (data, generation) => {
      const before = store.getState();
      if (generation !== before.snapshotRecoveryGeneration) return "stale-generation";

      const recovering = before.snapshotRecoveryStatus === "awaiting";
      const snapshotNextEventId = data.eventCursor + 1;
      const staleWhileLive = !recovering && before.nextEventId > snapshotNextEventId;
      set((state) => authoritativeSnapshotUpdates(state, data, !staleWhileLive));

      if (staleWhileLive) {
        touchRegistryEntry(key);
        return "ignored";
      }

      discardBufferedRemoteEventsThrough(store, data.eventCursor);
      if (recovering && !drainRecoveryBuffer(store, generation)) {
        set({ snapshotRecoveryStatus: "awaiting" });
        touchRegistryEntry(key);
        return "refresh-required";
      }
      set({ snapshotRecoveryStatus: "live" });
      touchRegistryEntry(key);
      return "applied";
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

export function markSessionForeground(
  slug: string,
  sessionId: string,
  foreground: boolean,
): void {
  const entry = sessionRegistry.get(scopedWebKey(slug, sessionId));
  if (!entry) return;
  entry.foreground = foreground;
  entry.lastAccessedAt = Date.now();
  if (!foreground) evictIdleSessionStores();
}

export function removeWebSessionStores(
  slug: string,
  sessionIds: readonly string[],
): void {
  for (const sessionId of new Set(sessionIds)) {
    const key = scopedWebKey(slug, sessionId);
    const entry = sessionRegistry.get(key);
    if (!entry) continue;
    pendingRemoteEvents.delete(entry.store);
    sessionRegistry.delete(key);
  }
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
  sessionSnapshotGeneration = 0;
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
