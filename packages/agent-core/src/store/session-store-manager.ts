import type { StoreApi } from "zustand";
import type { Logger } from "../logger";
import { sessionFileInternals, type SessionFile, type SessionSummary } from "./helpers";
import { __hasSessionsDirOverrideForTest } from "./sessions-dir";
import { createManagedSessionStore } from "./managed-session-store";
import type { SessionStoreState } from "./types";

export interface SessionStoreManagerOptions {
  readonly logger: Logger;
}

export class SessionStoreManager {
  #registry = new Map<string, StoreApi<SessionStoreState>>();
  #pendingLoads = new Map<string, Promise<StoreApi<SessionStoreState>>>();
  #pendingPersists = new Map<string, Promise<void>>();
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

    const persistWorkspaceRoot = workspaceRoot ?? (__hasSessionsDirOverrideForTest() ? "__test__" : undefined);

    const persistSession = persistWorkspaceRoot === undefined ? undefined : (state: SessionStoreState) => {
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

    const store = createManagedSessionStore({
      sessionId,
      persistSession,
      persistInitial: persistSession !== undefined,
    });

    this.#registry.set(key, store);
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

    const store = createManagedSessionStore({
      sessionId,
      initialState: {
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
        childSessionIds: new Set(parsed.childSessionIds),
        parentSessionId: parsed.parentSessionId,
        subAgentDescriptions: new Map(parsed.subAgentDescriptions),
        isRunning: false,
        isStreamingModel: false,
        currentRunId: undefined,
        currentAssistantMessageId: undefined,
        readSnapshots: new Map(),
        events: [],
        eventOffset: 0,
        nextEventId: 0,
      },
      persistSession: (state) => {
        const pending = this.#pendingPersists.get(key) ?? Promise.resolve();
        const next = pending
          .catch(() => { /* previous persist already logged — continue chain */ })
          .then(() => sessionFileInternals.saveSessionTranscript(state, workspaceRoot))
          .catch((err) => {
            this.#logger.warn("session.persist.failed", {
              error: err,
              context: { sessionId },
              meta: { workspaceRoot },
            });
          })
          .finally(() => {
            if (this.#pendingPersists.get(key) === next) this.#pendingPersists.delete(key);
          });
        this.#pendingPersists.set(key, next);
      },
      persistInitial: false,
    });

    this.#registry.set(key, store);
    return store;
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
