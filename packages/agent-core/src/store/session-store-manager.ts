import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ModelMessage } from "ai";
import { createEmptySessionStats } from "@specra/protocol";
import type { Logger } from "../logger";
import { sessionFileInternals, type SessionFile, type SessionSummary } from "./helpers";
import { toModelMessagesFromStoredMessages } from "./projection";
import { reduceStreamEvent } from "./reduce";
import { __hasSessionsDirOverrideForTest } from "./sessions-dir";
import {
  type SessionEventEnvelope,
  type SessionEventPayload,
  type SessionStoreState,
  type StreamEvent,
  MAX_EVENTS,
} from "./types";

export interface SessionStoreManagerOptions {
  readonly logger: Logger;
}

export class SessionStoreManager {
  #registry = new Map<string, StoreApi<SessionStoreState>>();
  #pendingLoads = new Map<string, Promise<StoreApi<SessionStoreState>>>();
  #pendingPersists = new Map<string, Promise<void>>();
  #hydrating = new Set<string>();
  readonly #logger: Logger;

  constructor(options: SessionStoreManagerOptions) {
    this.#logger = options.logger;
  }

  private key(sessionId: string, workspaceRoot?: string): string {
    return workspaceRoot === undefined ? sessionId : `${workspaceRoot}\0${sessionId}`;
  }

  create(sessionId: string, workspaceRoot?: string): StoreApi<SessionStoreState> {
    const key = this.key(sessionId, workspaceRoot);
    const existing = this.#registry.get(key);
    if (existing) return existing;

    const shouldPersist = workspaceRoot !== undefined || __hasSessionsDirOverrideForTest();
    const persistWorkspaceRoot = workspaceRoot ?? "__test__";
    let store: StoreApi<SessionStoreState>;

    const persist = () => {
      if (!shouldPersist) return;
      const state = store.getState();
      const pending = this.#pendingPersists.get(key) ?? Promise.resolve();
      const next = pending
        .catch(() => { /* previous persist already logged — continue chain */ })
        .then(() => sessionFileInternals.saveSessionTranscript(state, persistWorkspaceRoot))
        .catch((err) => {
          this.#logger.warn("session.persist.failed", {
            error: err,
            context: { sessionId },
            meta: { workspaceRoot: persistWorkspaceRoot === "__test__" ? undefined : persistWorkspaceRoot },
          });
        })
        .finally(() => {
          if (this.#pendingPersists.get(key) === next) this.#pendingPersists.delete(key);
        });
      this.#pendingPersists.set(key, next);
    };

    const persistForEvent = (event: SessionEventPayload) => {
      if (event.type === "user-message" || event.type === "run-end") persist();
    };

    store = createStore<SessionStoreState>((set, get) => ({
      sessionId,
      createdAt: Date.now(),
      title: null,
      messages: [],
      steps: [],
      stats: createEmptySessionStats(),
      runs: [],
      todos: [],
      reminders: [],
      rootSessionId: sessionId,
      parentSessionId: undefined,
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
        persistForEvent(event);
      },
      setTitle: (title: string | null) => {
        set({ title });
        persist();
      },
      setParentSessionId: (parentSessionId: string | undefined) => {
        set({ parentSessionId });
        persist();
      },
      toModelMessages: (): ModelMessage[] =>
        toModelMessagesFromStoredMessages(get().messages),
    }));

    this.#registry.set(key, store);
    if (!this.#hydrating.has(key)) persist();
    return store;
  }

  get(sessionId: string, workspaceRoot?: string): StoreApi<SessionStoreState> | undefined {
    return this.#registry.get(this.key(sessionId, workspaceRoot));
  }

  async getOrLoad(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<StoreApi<SessionStoreState>> {
    const key = this.key(sessionId, workspaceRoot);
    const existing = this.#registry.get(key);
    if (existing) return existing;

    const pending = this.#pendingLoads.get(key);
    if (pending) return pending;

    const promise = this.#loadFromDisk(sessionId, workspaceRoot);
    this.#pendingLoads.set(key, promise);

    try {
      return await promise;
    } finally {
      this.#pendingLoads.delete(key);
    }
  }

  async createSessionFile(workspaceRoot: string): Promise<SessionFile> {
    const store = this.create(crypto.randomUUID(), workspaceRoot);
    return sessionFileInternals.toSessionFile(store.getState());
  }

  async getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile> {
    const store = await this.getOrLoad(sessionId, workspaceRoot);
    return sessionFileInternals.toSessionFile(store.getState());
  }

  async listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
    return await sessionFileInternals.listSessionSummaries(workspaceRoot);
  }

  async #loadFromDisk(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<StoreApi<SessionStoreState>> {
    const parsed = await sessionFileInternals.readSessionFile(sessionId, workspaceRoot);

    // Re-check registry after I/O: a concurrent create() may have registered
    // a store for this key while we were reading from disk. If so, return it
    // without overwriting live state with stale disk data.
    const key = this.key(sessionId, workspaceRoot);
    const existing = this.#registry.get(key);
    if (existing) return existing;

    this.#hydrating.add(key);
    try {
      const store = this.create(sessionId, workspaceRoot);
      store.setState({
        sessionId: parsed.sessionId,
        createdAt: parsed.createdAt,
        title: parsed.title ?? null,
        messages: parsed.messages,
        steps: parsed.steps,
        stats: parsed.stats,
        runs: parsed.runs,
        runCount: parsed.runs.length,
        todos: parsed.todos ?? [],
        reminders: parsed.reminders,
        rootSessionId: parsed.rootSessionId,
        parentSessionId: parsed.parentSessionId,
        isRunning: false,
        isStreamingModel: false,
        currentRunId: undefined,
        currentAssistantMessageId: undefined,
        readSnapshots: new Map(),
        events: [],
        eventOffset: 0,
        nextEventId: 0,
      });

      return store;
    } finally {
      this.#hydrating.delete(key);
    }
  }

  delete(sessionId: string, workspaceRoot?: string): boolean {
    return this.#registry.delete(this.key(sessionId, workspaceRoot));
  }

  clearAll(): void {
    this.#registry.clear();
  }

  has(sessionId: string, workspaceRoot?: string): boolean {
    return this.#registry.has(this.key(sessionId, workspaceRoot));
  }
}
