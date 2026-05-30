import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ModelMessage } from "ai";
import { createEmptySessionStats } from "@specra/protocol";
import type { Logger } from "../logger";
import { sessionFileInternals, type SessionFile, type SessionSummary } from "./helpers";
import { toModelMessagesFromStoredMessages } from "./projection";
import { reduceStreamEvent } from "./reduce";
import { __hasSessionsDirOverrideForTest, getSessionsDir } from "./sessions-dir";
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
  #rootIdIndex = new Map<string, string>();
  #scanPromiseByWorkspace = new Map<string, Promise<void>>();
  readonly #logger: Logger;

  constructor(options: SessionStoreManagerOptions) {
    this.#logger = options.logger;
  }

  private key(sessionId: string, workspaceRoot?: string): string {
    return workspaceRoot === undefined ? sessionId : `${workspaceRoot}\0${sessionId}`;
  }

  private indexKey(sessionId: string, workspaceRoot: string): string {
    return `${workspaceRoot}\0${sessionId}`;
  }

  #registerRootSessionId(sessionId: string, workspaceRoot: string, rootSessionId: string): void {
    this.#rootIdIndex.set(this.indexKey(sessionId, workspaceRoot), rootSessionId);
  }

  #forgetWorkspaceIndex(workspaceRoot: string): void {
    const prefix = `${workspaceRoot}\0`;
    for (const key of this.#rootIdIndex.keys()) {
      if (key.startsWith(prefix)) this.#rootIdIndex.delete(key);
    }
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
    if (shouldPersist) this.#registerRootSessionId(sessionId, persistWorkspaceRoot, sessionId);
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
    const existing = this.get(sessionId, workspaceRoot);
    if (existing) return sessionFileInternals.toSessionFile(existing.getState());

    const rootSessionId = await this.resolveRootSessionId(sessionId, workspaceRoot);
    return await sessionFileInternals.readSessionFile(sessionId, workspaceRoot, rootSessionId);
  }

  async resolveRootSessionId(sessionId: string, workspaceRoot: string): Promise<string> {
    const cached = this.#rootIdIndex.get(this.indexKey(sessionId, workspaceRoot));
    if (cached !== undefined) return cached;

    if (await this.#isRootSessionOnDisk(sessionId, workspaceRoot)) {
      this.#registerRootSessionId(sessionId, workspaceRoot, sessionId);
      return sessionId;
    }

    await this.#scanWorkspaceDescendants(workspaceRoot);

    const resolved = this.#rootIdIndex.get(this.indexKey(sessionId, workspaceRoot));
    if (resolved !== undefined) return resolved;

    throw new Error(`Session file not found for "${sessionId}"`);
  }

  async listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
    return await sessionFileInternals.listSessionSummaries(workspaceRoot);
  }

  async #loadFromDisk(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<StoreApi<SessionStoreState>> {
    const rootSessionId = await this.resolveRootSessionId(sessionId, workspaceRoot);
    const parsed = await sessionFileInternals.readSessionFile(sessionId, workspaceRoot, rootSessionId);

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
      this.#registerRootSessionId(parsed.sessionId, workspaceRoot, parsed.rootSessionId);

      return store;
    } finally {
      this.#hydrating.delete(key);
    }
  }

  delete(sessionId: string, workspaceRoot?: string): boolean {
    const removed = this.#registry.delete(this.key(sessionId, workspaceRoot));
    if (workspaceRoot !== undefined) this.#forgetWorkspaceIndex(workspaceRoot);
    return removed;
  }

  clearAll(): void {
    this.#registry.clear();
    this.#rootIdIndex.clear();
    this.#scanPromiseByWorkspace.clear();
  }

  has(sessionId: string, workspaceRoot?: string): boolean {
    return this.#registry.has(this.key(sessionId, workspaceRoot));
  }

  async #isRootSessionOnDisk(sessionId: string, workspaceRoot: string): Promise<boolean> {
    try {
      const file = await sessionFileInternals.readSessionFile(sessionId, workspaceRoot, sessionId);
      return file.rootSessionId === sessionId;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

  async #scanWorkspaceDescendants(workspaceRoot: string): Promise<void> {
    const pending = this.#scanPromiseByWorkspace.get(workspaceRoot);
    if (pending) return pending;

    const scan = this.#scanWorkspaceDescendantsOnce(workspaceRoot).finally(() => {
      if (this.#scanPromiseByWorkspace.get(workspaceRoot) === scan) {
        this.#scanPromiseByWorkspace.delete(workspaceRoot);
      }
    });
    this.#scanPromiseByWorkspace.set(workspaceRoot, scan);
    return scan;
  }

  async #scanWorkspaceDescendantsOnce(workspaceRoot: string): Promise<void> {
    const rootSessionIds = new Set<string>();
    for (const summary of await sessionFileInternals.listSessionSummaries(workspaceRoot)) {
      rootSessionIds.add(summary.rootSessionId);
      this.#registerRootSessionId(summary.sessionId, workspaceRoot, summary.rootSessionId);
    }
    for (const dirname of await sessionFileInternals.readTopLevelSessionDirNames(getSessionsDir(workspaceRoot))) {
      rootSessionIds.add(dirname);
    }

    for (const rootSessionId of rootSessionIds) {
      let descendants: Map<string, string>;
      try {
        descendants = await sessionFileInternals.scanDescendants(workspaceRoot, rootSessionId);
      } catch (error) {
        this.#logger.warn("session.descendant_scan.failed", {
          error,
          context: { sessionId: rootSessionId },
          meta: { workspaceRoot },
        });
        continue;
      }
      for (const [childSessionId, childRootSessionId] of descendants) {
        this.#registerRootSessionId(childSessionId, workspaceRoot, childRootSessionId);
      }
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
