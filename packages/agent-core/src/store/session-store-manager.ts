import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ModelMessage } from "ai";
import { createEmptySessionStats } from "@archcode/protocol";
import type { AgentName } from "../agents/names";
import { collectSessionTreeIds } from "../execution/session-tree";
import { createEmptyCompressionState, resolveCompressionOriginalRange, type CompressionOriginalRangeResult } from "../compression";
import type {
  SessionModelSelection,
  SessionTreeNode,
  SessionTreeResponse,
} from "@archcode/protocol";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Logger } from "../logger";
import {
  InvalidSessionCwdError,
  NotRootSessionError,
  SessionCwdPathBarrierError,
  SessionCwdReferenceScanError,
  SessionFileNotFoundError,
  SessionInitialPersistenceError,
  SessionTreeIntegrityError,
} from "./errors";
import { SessionFileSchema, sessionFileInternals, type HydratedSessionFile, type SessionSummary } from "./helpers";
import { projectModelMessagesFromStoredMessages } from "./projection";
import { reduceStreamEvent } from "./reduce";
import { toDurableSessionEvent } from "./durable-tool-input";
import { assertSafeSessionId, getSessionPath, getSessionsDir } from "./sessions-dir";
import {
  type ReasoningPart,
  type SessionEventEnvelope,
  type SessionEventPayload,
  type SessionRole,
  type SessionStoreState,
  type SessionToolBatch,
  type TextPart,
  MAX_EVENTS,
} from "./types";

export interface SessionStoreManagerOptions {
  readonly logger: Logger;
}

export interface DurableSessionMutation<T> {
  readonly result: T;
  readonly patch?: Partial<SessionStoreState>;
  readonly events?: readonly SessionEventPayload[];
}

export interface PublishableSessionEvent {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly agentName: AgentName;
  readonly envelope: SessionEventEnvelope;
}

export type SessionEventSourceListener = (event: PublishableSessionEvent) => void;

export interface CreateSessionOptions {
  readonly agentName: AgentName;
  /** Canonical Skill identity. New root Sessions use an empty list. */
  readonly activeSkillNames?: readonly string[];
  readonly cwd?: string;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly goalId?: string;
  readonly sessionRole?: SessionRole;
  readonly modelSelection?: SessionModelSelection;
  readonly title?: string;
}

export interface SessionCwdReference {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly cwd: string;
}

export interface SessionCwdPathBarrierLease {
  readonly cwd: string;
  readonly generation: symbol;
  release(): void;
}

export class SessionFileIdentityConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly field: string,
    public readonly expected: unknown,
    public readonly actual: unknown,
  ) {
    super(`Session ${sessionId} identity conflict for ${field}`);
    this.name = "SessionFileIdentityConflictError";
  }
}

export class SessionStoreManager {
  #registry = new Map<string, StoreApi<SessionStoreState>>();
  #pendingLoads = new Map<string, Promise<StoreApi<SessionStoreState>>>();
  #pendingPersists = new Map<string, Promise<void>>();
  #persistFailures = new Map<string, unknown>();
  /** targetNextEventId -> first event id withheld by that durable transaction. */
  #publicationBarriers = new Map<string, Map<number, number>>();
  #eventSourceListeners = new Set<SessionEventSourceListener>();
  #hydrating = new Set<string>();
  // Disposable acceleration for child lookups; source of truth stays on disk.
  #rootIdIndex = new Map<string, string>();
  #scanPromiseByWorkspace = new Map<string, Promise<void>>();
  #cwdPathBarriers = new Map<string, symbol>();
  readonly #logger: Logger;

  constructor(options: SessionStoreManagerOptions) {
    this.#logger = options.logger;
  }

  private key(sessionId: string, workspaceRoot: string): string {
    return `${workspaceRoot}\0${sessionId}`;
  }

  #registerRootSessionId(sessionId: string, workspaceRoot: string, rootSessionId: string): void {
    this.#rootIdIndex.set(this.key(sessionId, workspaceRoot), rootSessionId);
  }

  #forgetWorkspaceIndex(workspaceRoot: string): void {
    const prefix = `${workspaceRoot}\0`;
    for (const key of this.#rootIdIndex.keys()) {
      if (key.startsWith(prefix)) this.#rootIdIndex.delete(key);
    }
  }

  #forgetSessionIndex(sessionId: string, workspaceRoot: string): void {
    this.#rootIdIndex.delete(this.key(sessionId, workspaceRoot));
  }

  create(sessionId: string, workspaceRoot: string, options: CreateSessionOptions): StoreApi<SessionStoreState> {
    const key = this.key(sessionId, workspaceRoot);
    const existing = this.#registry.get(key);
    if (existing) return existing;

    const rootSessionId = options.rootSessionId ?? sessionId;
    const cwd = options.cwd ?? workspaceRoot;
    if (!isAbsolute(cwd)) throw new InvalidSessionCwdError(cwd, "must be an absolute path");
    if (!this.#hydrating.has(key)) this.#assertCwdTargetAllowed(cwd);
    const parentSessionId = options.parentSessionId;
    const goalId = options.goalId;
    const sessionRole = options.sessionRole;
    let store: StoreApi<SessionStoreState>;

    const persist = () => {
      const state = store.getState();
      return this.#enqueuePersist(key, sessionId, workspaceRoot, state);
    };

    const persistForEvent = (event: SessionEventPayload) => {
      if (
        event.type === "execution-start"
        || event.type === "execution-end"
        || event.type === "tool-attempt"
        || event.type === "tool-result"
        || event.type === "session.cwd_changed"
        || event.type === "session.model_selection_changed"
        || event.type === "llm-retry"
        || event.type === "llm-recovery"
        || event.type === "llm-recovery-failed"
        || event.type === "compact"
        || event.type === "tool-child-session-link"
        || event.type === "execution-error"
        || event.type === "compression.block_committed"
        || event.type === "compression.block_failed"
        || event.type === "compression.ref_map_updated"
      ) return persist();
      return undefined;
    };

    const createdAt = Date.now();
    store = createStore<SessionStoreState>((set, get) => ({
      sessionId,
      createdAt,
      updatedAt: createdAt,
      cwd,
      agentName: options.agentName,
      activeSkillNames: [...new Set(options.activeSkillNames ?? [])],
      modelSelection: options.modelSelection ?? { revision: 0 },
      title: options.title ?? null,
      messages: [],
      pendingMessages: [],
      inputRequestReceipts: [],
      steps: [],
      stats: createEmptySessionStats(),
      executions: [],
      compression: createEmptyCompressionState(),
      todos: [],
      reminders: [],
      childSessionLinks: [],
      toolBatches: [],
      // Root/parent IDs are write-once session identity, not mutable tree state.
      rootSessionId,
      parentSessionId,
      goalId,
      sessionRole,
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
      publishableNextEventId: 0,
      append: (event: SessionEventPayload) => {
        const durableEvent = toDurableSessionEvent(event);
        const durablePublication = isDurableControlEvent(durableEvent);
        let startNextEventId = 0;
        let targetNextEventId = 0;
        let previousPublishableNextEventId = 0;
        let nextPublishableNextEventId = 0;
        set((state) => {
          previousPublishableNextEventId = state.publishableNextEventId;
          startNextEventId = state.nextEventId;
          const envelope: SessionEventEnvelope = {
            id: state.nextEventId,
            createdAt: Date.now(),
            payload: durableEvent,
          };

          const events = [...state.events, envelope];
          let eventOffset = state.eventOffset;
          const nextEventId = state.nextEventId + 1;

          if (events.length > MAX_EVENTS) {
            const dropCount = Math.min(
              events.length - MAX_EVENTS,
              Math.max(0, state.publishableNextEventId - state.eventOffset),
            );
            events.splice(0, dropCount);
            eventOffset += dropCount;
          }

          const partial = reduceStoreEvent(state, durableEvent);
          targetNextEventId = nextEventId;
          const publishableNextEventId = durablePublication || this.#hasPublicationBarrier(key)
            ? state.publishableNextEventId
            : nextEventId;
          nextPublishableNextEventId = publishableNextEventId;

          return { ...partial, events, eventOffset, nextEventId, publishableNextEventId };
        });
        if (!durablePublication) {
          this.#emitPublishableRange(
            workspaceRoot,
            sessionId,
            store,
            previousPublishableNextEventId,
            nextPublishableNextEventId,
          );
        }
        const persistence = persistForEvent(durableEvent);
        if (durablePublication) {
          this.#trackPublicationBarrier(key, startNextEventId, targetNextEventId);
          const operation = persistence ?? persist();
          void operation.then(
            () => this.#resolvePublicationBarrier(key, workspaceRoot, sessionId, store, targetNextEventId),
            () => undefined,
          );
        }
      },
      setCwd: (nextCwd: string) => {
        const previousCwd = get().cwd;
        if (previousCwd === nextCwd) return;
        get().append({ type: "session.cwd_changed", previousCwd, cwd: nextCwd });
      },
      setTitle: (title: string | null) => {
        set({ title });
        persist();
      },
      setParentSessionId: (parentSessionId: string | undefined) => {
        const current = get().parentSessionId;
        if (current !== undefined) return; // Identity is immutable after creation
        set({ parentSessionId });
        persist();
      },
      setGoalId: (goalId: string | undefined) => {
        set({ goalId });
        persist();
      },
      setSessionRole: (sessionRole: SessionRole | undefined) => {
        set({ sessionRole });
        persist();
      },
      toModelMessages: (): ModelMessage[] => {
        const state = get();
        const compression = state.compression;
        const projection = projectModelMessagesFromStoredMessages(state.messages, { compression });
        if (projection.refMap !== undefined && projection.refMap !== compression.refMap) {
          set({ compression: { ...compression, refMap: projection.refMap, updatedAt: Date.now() } });
          persist();
        }
        return projection.messages;
      },
    }));

    this.#registry.set(key, store);
    this.#registerRootSessionId(sessionId, workspaceRoot, rootSessionId);
    if (!this.#hydrating.has(key)) persist();
    return store;
  }

  get(sessionId: string, workspaceRoot: string): StoreApi<SessionStoreState> | undefined {
    return this.#registry.get(this.key(sessionId, workspaceRoot));
  }

  /** Waits until every Session snapshot queued before or during this call is durable. */
  async flushSession(sessionId: string, workspaceRoot: string): Promise<void> {
    const key = this.key(sessionId, workspaceRoot);
    while (true) {
      const pending = this.#pendingPersists.get(key);
      if (pending === undefined) {
        const failure = this.#persistFailures.get(key);
        if (failure !== undefined) throw failure;
        return;
      }
      await pending;
    }
  }

  /**
   * Applies one synchronous domain mutation, persists its complete snapshot, then publishes
   * its ordered control events. The callback must not perform I/O or retain the state object.
   */
  async commitDurableSessionMutation<T>(
    sessionId: string,
    workspaceRoot: string,
    mutate: (state: Readonly<SessionStoreState>) => DurableSessionMutation<T>,
  ): Promise<T> {
    const store = await this.getOrLoad(sessionId, workspaceRoot);
    const key = this.key(sessionId, workspaceRoot);
    const priorFailure = this.#persistFailures.get(key);
    if (priorFailure !== undefined) throw priorFailure;

    let outcome: DurableSessionMutation<T> | undefined;
    const startNextEventId = store.getState().nextEventId;
    let targetNextEventId = startNextEventId;
    store.setState((state) => {
      outcome = mutate(state);
      let nextState = { ...state, ...(outcome.patch ?? {}) };
      for (const rawEvent of outcome.events ?? []) {
        const event = toDurableSessionEvent(rawEvent);
        nextState = appendEventToState(nextState, event, false);
      }
      targetNextEventId = nextState.nextEventId;
      return nextState;
    }, true);

    if (outcome === undefined) throw new Error("Durable Session mutation did not produce an outcome");
    const hasEvents = targetNextEventId > startNextEventId;
    if (hasEvents) this.#trackPublicationBarrier(key, startNextEventId, targetNextEventId);

    const operation = this.#enqueuePersist(key, sessionId, workspaceRoot, store.getState());
    await operation;
    if (hasEvents) {
      this.#resolvePublicationBarrier(key, workspaceRoot, sessionId, store, targetNextEventId);
    }
    return outcome.result;
  }

  /** Emits every newly publishable raw Session event, independent of Execution lifetime. */
  subscribeToSessionEvents(listener: SessionEventSourceListener): () => void {
    this.#eventSourceListeners.add(listener);
    return () => this.#eventSourceListeners.delete(listener);
  }

  /** Atomically mutates the canonical Session tool-batch checkpoint and awaits durability. */
  async updateToolBatches(
    sessionId: string,
    workspaceRoot: string,
    update: (batches: readonly SessionToolBatch[]) => SessionToolBatch[],
  ): Promise<SessionToolBatch[]> {
    const store = await this.getOrLoad(sessionId, workspaceRoot);
    let updated: SessionToolBatch[] = [];
    store.setState((state) => {
      updated = update(state.toolBatches);
      return { toolBatches: updated, updatedAt: Date.now() };
    });
    await this.#enqueuePersist(this.key(sessionId, workspaceRoot), sessionId, workspaceRoot, store.getState());
    return updated;
  }

  /** Lists roots and descendants for project startup repair services. */
  async listAllSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
    return await sessionFileInternals.scanAllSessionSummaries(workspaceRoot);
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

  async createSessionFile(
    workspaceRoot: string,
    options: CreateSessionOptions,
    sessionId: string = crypto.randomUUID(),
  ): Promise<HydratedSessionFile> {
    const store = this.create(sessionId, workspaceRoot, options);
    const key = this.key(sessionId, workspaceRoot);
    const initialPersist = this.#pendingPersists.get(key);
    if (initialPersist === undefined) {
      this.delete(sessionId, workspaceRoot);
      throw new SessionInitialPersistenceError(
        sessionId,
        workspaceRoot,
        new Error("Initial Session persistence was not scheduled"),
      );
    }

    try {
      await initialPersist;
    } catch (error) {
      this.delete(sessionId, workspaceRoot);
      throw new SessionInitialPersistenceError(sessionId, workspaceRoot, error);
    }
    return sessionFileInternals.toSessionFile(store.getState());
  }

  /** Creates a caller-selected Session id or verifies the durable identity already using it. */
  async ensureSessionFile(
    workspaceRoot: string,
    sessionId: string,
    options: CreateSessionOptions,
  ): Promise<HydratedSessionFile> {
    let existing: HydratedSessionFile | undefined;
    try {
      existing = await this.getSessionFile(workspaceRoot, sessionId);
    } catch (error) {
      if (!(error instanceof SessionFileNotFoundError)) throw error;
    }

    const session = existing ?? await this.createSessionFile(workspaceRoot, options, sessionId);
    const expected = {
      sessionId,
      rootSessionId: options.rootSessionId ?? sessionId,
      parentSessionId: options.parentSessionId,
      goalId: options.goalId,
      sessionRole: options.sessionRole,
      agentName: options.agentName,
      activeSkillNames: [...new Set(options.activeSkillNames ?? [])],
      cwd: options.cwd ?? workspaceRoot,
    } as const;
    const actual = {
      sessionId: session.sessionId,
      rootSessionId: session.rootSessionId,
      parentSessionId: session.parentSessionId,
      goalId: session.goalId,
      sessionRole: session.sessionRole,
      agentName: session.agentName,
      activeSkillNames: session.activeSkillNames,
      cwd: session.cwd,
    } as const;

    for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
      const matches = field === "cwd"
        ? sameResolvedPath(String(expected[field]), String(actual[field]))
        : field === "activeSkillNames"
          ? JSON.stringify(expected.activeSkillNames) === JSON.stringify(actual.activeSkillNames)
        : expected[field] === actual[field];
      if (!matches) {
        throw new SessionFileIdentityConflictError(sessionId, field, expected[field], actual[field]);
      }
    }
    return session;
  }

  async getSessionFile(workspaceRoot: string, sessionId: string): Promise<HydratedSessionFile> {
    const existing = this.get(sessionId, workspaceRoot);
    if (existing) return sessionFileInternals.toSessionFile(existing.getState());

    const rootSessionId = await this.resolveRootSessionId(sessionId, workspaceRoot);
    return reconcileInterruptedSessionFile(await sessionFileInternals.readSessionFile(sessionId, workspaceRoot, rootSessionId));
  }

  async resolveCompressionOriginalRange(
    workspaceRoot: string,
    sessionId: string,
    blockRef: string,
  ): Promise<CompressionOriginalRangeResult> {
    const session = await this.getSessionFile(workspaceRoot, sessionId);
    return resolveCompressionOriginalRange(session, blockRef);
  }

  async setGoalId(sessionId: string, goalId: string | undefined, workspaceRoot: string): Promise<SessionStoreState> {
    const store = await this.getOrLoad(sessionId, workspaceRoot);
    store.getState().setGoalId(goalId);
    return store.getState();
  }

  /**
   * Atomically changes the execution directory without moving Session storage.
   * Tool callers await this method before rebuilding their Agent runtime.
   */
  async updateCwd(
    sessionId: string,
    workspaceRoot: string,
    cwd: string,
    expectedCwd?: string,
  ): Promise<SessionStoreState> {
    if (!isAbsolute(cwd)) throw new InvalidSessionCwdError(cwd);
    this.#assertCwdTargetAllowed(cwd);
    return await this.#updateCwd(sessionId, workspaceRoot, cwd, expectedCwd);
  }

  async updateCwdForMigration(
    sessionId: string,
    workspaceRoot: string,
    cwd: string,
    expectedCwd: string,
    barrier: SessionCwdPathBarrierLease,
  ): Promise<SessionStoreState> {
    if (!isAbsolute(cwd) || !isAbsolute(expectedCwd)) {
      throw new InvalidSessionCwdError(!isAbsolute(cwd) ? cwd : expectedCwd);
    }
    this.#assertActiveCwdPathBarrier(barrier);
    if (!sameResolvedPath(cwd, barrier.cwd) && !sameResolvedPath(expectedCwd, barrier.cwd)) {
      throw new SessionCwdPathBarrierError(barrier.cwd, "target_blocked");
    }
    return await this.#updateCwd(sessionId, workspaceRoot, cwd, expectedCwd, barrier);
  }

  async #updateCwd(
    sessionId: string,
    workspaceRoot: string,
    cwd: string,
    expectedCwd?: string,
    barrier?: SessionCwdPathBarrierLease,
  ): Promise<SessionStoreState> {
    if (!isAbsolute(cwd)) throw new InvalidSessionCwdError(cwd);
    const store = await this.getOrLoad(sessionId, workspaceRoot);
    const previousCwd = store.getState().cwd;
    const previousSnapshots = store.getState().readSnapshots;
    if (expectedCwd !== undefined && previousCwd !== expectedCwd) {
      throw new InvalidSessionCwdError(cwd, `expected current cwd ${expectedCwd}, got ${previousCwd}`);
    }
    if (previousCwd === cwd) return store.getState();
    this.#assertCwdTargetAllowed(cwd, barrier);

    const key = this.key(sessionId, workspaceRoot);
    store.getState().append({ type: "session.cwd_changed", previousCwd, cwd });
    try {
      await this.#pendingPersists.get(key);
    } catch (error) {
      store.getState().append({ type: "session.cwd_changed", previousCwd: cwd, cwd: previousCwd });
      store.setState({ readSnapshots: previousSnapshots });
      try {
        await this.#pendingPersists.get(key);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Failed to persist or roll back Session cwd for ${sessionId}`);
      }
      throw error;
    }
    return store.getState();
  }

  acquireCwdPathBarrier(cwd: string): SessionCwdPathBarrierLease {
    if (!isAbsolute(cwd)) throw new InvalidSessionCwdError(cwd);
    const key = resolve(cwd);
    if (this.#cwdPathBarriers.has(key)) throw new SessionCwdPathBarrierError(cwd, "already_held");
    const generation = Symbol(`session-cwd-path-barrier:${key}`);
    this.#cwdPathBarriers.set(key, generation);
    let released = false;
    return {
      cwd: key,
      generation,
      release: () => {
        if (released) return;
        released = true;
        if (this.#cwdPathBarriers.get(key) === generation) this.#cwdPathBarriers.delete(key);
      },
    };
  }

  async scanCwdReferencesStrict(workspaceRoot: string, cwd: string): Promise<SessionCwdReference[]> {
    if (!isAbsolute(cwd)) throw new InvalidSessionCwdError(cwd);
    await this.#flushWorkspacePersists(workspaceRoot);

    const disk = new Map<string, SessionCwdReference>();
    const names = await this.#strictSessionDirectoryNames(workspaceRoot);
    for (const name of names.sort()) {
      const fallbackPath = join(getSessionsDir(workspaceRoot), name, "session.json");
      try {
        assertSafeSessionId(name);
        const parsed = await sessionFileInternals.readSessionFile(name, workspaceRoot);
        assertSafeSessionId(parsed.rootSessionId);
        const parsedCwd = parsed.cwd;
        if (!isAbsolute(parsedCwd)) throw new InvalidSessionCwdError(parsedCwd);
        disk.set(parsed.sessionId, {
          sessionId: parsed.sessionId,
          rootSessionId: parsed.rootSessionId,
          cwd: parsedCwd,
        });
      } catch (error) {
        throw new SessionCwdReferenceScanError(
          workspaceRoot,
          fallbackPath,
          `Invalid Session file blocks cwd reference migration: ${fallbackPath}`,
          error,
        );
      }
    }

    const live = new Map<string, SessionCwdReference>();
    const prefix = `${workspaceRoot}\0`;
    for (const [key, store] of this.#registry.entries()) {
      if (!key.startsWith(prefix)) continue;
      const state = store.getState();
      try {
        assertSafeSessionId(state.sessionId);
        assertSafeSessionId(state.rootSessionId);
      } catch (error) {
        throw new SessionCwdReferenceScanError(
          workspaceRoot,
          undefined,
          `Loaded Session has invalid identity: ${state.sessionId}`,
          error,
        );
      }
      if (!isAbsolute(state.cwd)) {
        throw new SessionCwdReferenceScanError(
          workspaceRoot,
          undefined,
          `Loaded Session ${state.sessionId} has invalid cwd: ${state.cwd}`,
        );
      }
      live.set(state.sessionId, {
        sessionId: state.sessionId,
        rootSessionId: state.rootSessionId,
        cwd: state.cwd,
      });
    }

    for (const [sessionId, liveReference] of live) {
      const diskReference = disk.get(sessionId);
      if (diskReference === undefined) continue;
      if (
        diskReference.rootSessionId !== liveReference.rootSessionId
        || !sameResolvedPath(diskReference.cwd, liveReference.cwd)
      ) {
        throw new SessionCwdReferenceScanError(
          workspaceRoot,
          getSessionPath(workspaceRoot, sessionId),
          `Loaded and persisted Session identity diverged during cwd reference migration: ${sessionId}`,
        );
      }
    }

    const references = new Map(disk);
    for (const [sessionId, reference] of live) references.set(sessionId, reference);
    return [...references.values()]
      .filter((reference) => sameResolvedPath(reference.cwd, cwd))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  #assertCwdTargetAllowed(cwd: string, barrier?: SessionCwdPathBarrierLease): void {
    const key = resolve(cwd);
    const active = this.#cwdPathBarriers.get(key);
    if (active === undefined) return;
    if (barrier !== undefined && barrier.generation === active && resolve(barrier.cwd) === key) return;
    throw new SessionCwdPathBarrierError(cwd, "target_blocked");
  }

  #assertActiveCwdPathBarrier(barrier: SessionCwdPathBarrierLease): void {
    if (this.#cwdPathBarriers.get(resolve(barrier.cwd)) !== barrier.generation) {
      throw new SessionCwdPathBarrierError(barrier.cwd, "lease_expired");
    }
  }

  async #flushWorkspacePersists(workspaceRoot: string): Promise<void> {
    const prefix = `${workspaceRoot}\0`;
    try {
      while (true) {
        const pending = [...this.#pendingPersists.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, operation]) => operation);
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    } catch (error) {
      throw new SessionCwdReferenceScanError(
        workspaceRoot,
        undefined,
        "Pending Session persistence failed before cwd reference migration",
        error,
      );
    }
  }

  async #strictSessionDirectoryNames(workspaceRoot: string): Promise<string[]> {
    const sessionsDir = getSessionsDir(workspaceRoot);
    let entries;
    try {
      entries = await readdir(sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw new SessionCwdReferenceScanError(
        workspaceRoot,
        sessionsDir,
        `Unable to enumerate Session files for cwd reference migration: ${sessionsDir}`,
        error,
      );
    }
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      throw new SessionCwdReferenceScanError(
        workspaceRoot,
        join(sessionsDir, entry.name),
        `Unexpected entry blocks strict Session cwd reference scan: ${entry.name}`,
      );
    }
    return entries.map((entry) => entry.name);
  }

  #enqueuePersist(
    key: string,
    sessionId: string,
    workspaceRoot: string,
    state: SessionStoreState,
  ): Promise<void> {
    const updatedAt = Math.max(Date.now(), state.updatedAt + 1);
    const persistState = { ...state, updatedAt };
    this.#registry.get(key)?.setState({ updatedAt });
    const previousFailure = this.#persistFailures.get(key);
    const pending = this.#pendingPersists.get(key)
      ?? (previousFailure === undefined ? Promise.resolve() : Promise.reject(previousFailure));
    const operation = pending.then(() => sessionFileInternals.saveSessionTranscript(persistState, workspaceRoot));
    this.#pendingPersists.set(key, operation);
    void operation
      .catch((error) => {
        this.#persistFailures.set(key, error);
        this.#logger.warn("session.persist.failed", {
          error,
          context: { sessionId },
          meta: { workspaceRoot },
        });
      })
      .finally(() => {
        if (this.#pendingPersists.get(key) === operation) this.#pendingPersists.delete(key);
      });
    return operation;
  }

  #hasPublicationBarrier(key: string): boolean {
    return (this.#publicationBarriers.get(key)?.size ?? 0) > 0;
  }

  #trackPublicationBarrier(
    key: string,
    startNextEventId: number,
    targetNextEventId: number,
  ): void {
    const barriers = this.#publicationBarriers.get(key) ?? new Map<number, number>();
    barriers.set(targetNextEventId, startNextEventId);
    this.#publicationBarriers.set(key, barriers);
  }

  #resolvePublicationBarrier(
    key: string,
    workspaceRoot: string,
    sessionId: string,
    store: StoreApi<SessionStoreState>,
    targetNextEventId: number,
  ): void {
    const barriers = this.#publicationBarriers.get(key);
    barriers?.delete(targetNextEventId);
    if (barriers?.size === 0) this.#publicationBarriers.delete(key);

    const state = store.getState();
    const nextBarrierStart = barriers === undefined || barriers.size === 0
      ? undefined
      : Math.min(...barriers.values());
    const publishableNextEventId = Math.max(
      state.publishableNextEventId,
      nextBarrierStart === undefined ? state.nextEventId : nextBarrierStart,
    );
    if (publishableNextEventId === state.publishableNextEventId) return;

    const previous = state.publishableNextEventId;
    store.setState({ publishableNextEventId });
    this.#emitPublishableRange(workspaceRoot, sessionId, store, previous, publishableNextEventId);
    const published = store.getState();
    if (published.events.length > MAX_EVENTS) {
      const dropCount = published.events.length - MAX_EVENTS;
      store.setState({
        events: published.events.slice(dropCount),
        eventOffset: published.eventOffset + dropCount,
      });
    }
  }

  #emitPublishableRange(
    workspaceRoot: string,
    sessionId: string,
    store: StoreApi<SessionStoreState>,
    startNextEventId: number,
    endNextEventId: number,
  ): void {
    if (endNextEventId <= startNextEventId || this.#eventSourceListeners.size === 0) return;
    const state = store.getState();
    const start = Math.max(startNextEventId, state.eventOffset) - state.eventOffset;
    const end = Math.max(endNextEventId, state.eventOffset) - state.eventOffset;
    for (const envelope of state.events.slice(start, end)) {
      const event: PublishableSessionEvent = {
        workspaceRoot,
        sessionId,
        agentName: state.agentName,
        envelope,
      };
      for (const listener of this.#eventSourceListeners) {
        try {
          listener(event);
        } catch (error) {
          this.#logger.warn("session.event_listener.failed", {
            error,
            context: { sessionId },
            meta: { workspaceRoot, eventId: envelope.id },
          });
        }
      }
    }
  }

  appendSessionEvent(sessionId: string, event: SessionEventPayload, workspaceRoot: string): boolean {
    const store = this.get(sessionId, workspaceRoot);
    if (store === undefined) return false;

    store.getState().append(event);
    return true;
  }

  async resolveRootSessionId(sessionId: string, workspaceRoot: string): Promise<string> {
    const cached = this.#rootIdIndex.get(this.key(sessionId, workspaceRoot));
    if (cached !== undefined) return cached;

    if (await this.#isRootSessionOnDisk(sessionId, workspaceRoot)) {
      this.#registerRootSessionId(sessionId, workspaceRoot, sessionId);
      return sessionId;
    }

    await this.#scanWorkspaceDescendants(workspaceRoot);

    const resolved = this.#rootIdIndex.get(this.key(sessionId, workspaceRoot));
    if (resolved !== undefined) return resolved;

    throw new SessionFileNotFoundError(sessionId);
  }

  async listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
    return await sessionFileInternals.listSessionSummaries(workspaceRoot);
  }

  /**
   * Resolves authoritative delegation depth from the persisted parent chain.
   * This intentionally ignores child-link and tool-batch display metadata.
   */
  async resolveSessionDepth(workspaceRoot: string, sessionId: string): Promise<number> {
    let current = reconcileInterruptedSessionFile(
      await sessionFileInternals.readSessionFile(sessionId, workspaceRoot),
    );
    const rootSessionId = current.rootSessionId;
    const seen = new Set<string>();
    let depth = 0;

    while (true) {
      if (seen.has(current.sessionId)) {
        throw new SessionTreeIntegrityError(
          "cycle",
          current.sessionId,
          getSessionPath(workspaceRoot, current.sessionId),
          `Cycle detected in parent chain for Session "${sessionId}"`,
        );
      }
      seen.add(current.sessionId);

      if (current.rootSessionId !== rootSessionId) {
        throw new SessionTreeIntegrityError(
          "root_mismatch",
          current.sessionId,
          getSessionPath(workspaceRoot, current.sessionId),
          `Session "${current.sessionId}" belongs to root "${current.rootSessionId}", expected "${rootSessionId}"`,
        );
      }

      const parentSessionId = current.parentSessionId;
      if (parentSessionId === undefined) {
        if (current.sessionId !== rootSessionId) {
          throw new SessionTreeIntegrityError(
            "missing_parent",
            current.sessionId,
            getSessionPath(workspaceRoot, current.sessionId),
            `Parent chain for Session "${sessionId}" ended at "${current.sessionId}" instead of root "${rootSessionId}"`,
          );
        }
        return depth;
      }

      try {
        current = reconcileInterruptedSessionFile(
          await sessionFileInternals.readSessionFile(parentSessionId, workspaceRoot),
        );
      } catch (error) {
        if (!(error instanceof SessionFileNotFoundError) && !isMissingFileError(error)) throw error;
        throw new SessionTreeIntegrityError(
          "missing_parent",
          current.sessionId,
          getSessionPath(workspaceRoot, current.sessionId),
          `Parent Session "${parentSessionId}" for "${current.sessionId}" was not found`,
          error,
        );
      }
      depth += 1;
    }
  }

  async buildSessionTree(workspaceRoot: string, rootSessionId: string): Promise<SessionTreeResponse> {
    const rootFile = reconcileInterruptedSessionFile(await sessionFileInternals.readSessionFile(rootSessionId, workspaceRoot, rootSessionId));
    const rootFilePath = getSessionPath(workspaceRoot, rootSessionId);
    if (rootFile.sessionId !== rootSessionId) {
      throw new SessionTreeIntegrityError(
        "session_id_mismatch",
        rootFile.sessionId,
        rootFilePath,
        `Session ID mismatch: expected "${rootSessionId}", found "${rootFile.sessionId}" in file`,
      );
    }
    if (rootFile.parentSessionId !== undefined) {
      throw new NotRootSessionError(rootSessionId, rootFile.parentSessionId);
    }
    if (rootFile.rootSessionId !== rootSessionId) {
      throw new SessionTreeIntegrityError(
        "root_mismatch",
        rootFile.sessionId,
        rootFilePath,
        `Root session ID mismatch: expected "${rootSessionId}", found "${rootFile.rootSessionId}" in file`,
      );
    }

    const rootNode: SessionTreeNode = { session: toSessionSummary(rootFile), children: [] };
    const sessions = new Map<string, SessionSummary>([[rootSessionId, rootNode.session]]);
    const parsedEntries: Array<{
      entry: { sessionId: string; filePath: string };
      summary: SessionSummary;
    }> = [];

    for (const entry of await readDescendantSessionEntries(workspaceRoot, rootSessionId)) {
      const parsed = await readSessionFileForTree(entry.sessionId, entry.filePath);
      if (sessions.has(parsed.sessionId)) {
        throw new SessionTreeIntegrityError(
          "duplicate_session",
          parsed.sessionId,
          entry.filePath,
          `Duplicate session ID "${parsed.sessionId}" found while building tree`,
        );
      }
      if (parsed.sessionId !== entry.sessionId) {
        throw new SessionTreeIntegrityError(
          "session_id_mismatch",
          parsed.sessionId,
          entry.filePath,
          `Session ID mismatch: expected "${entry.sessionId}", found "${parsed.sessionId}" in file`,
        );
      }

      const summary = toSessionSummary(parsed);
      sessions.set(summary.sessionId, summary);
      parsedEntries.push({ entry, summary });
    }

    for (const { entry, summary } of parsedEntries) {
      const parentSessionId = summary.parentSessionId;
      if (parentSessionId === undefined) {
        if (summary.rootSessionId !== summary.sessionId) {
          throw new SessionTreeIntegrityError(
            "not_root",
            summary.sessionId,
            entry.filePath,
            `Session "${summary.sessionId}" has no parent but declares root "${summary.rootSessionId}"`,
          );
        }
        continue;
      }

      const parent = sessions.get(parentSessionId);
      if (parent === undefined) {
        throw new SessionTreeIntegrityError(
          "missing_parent",
          summary.sessionId,
          entry.filePath,
          `Parent session "${parentSessionId}" for "${summary.sessionId}" was not found`,
        );
      }
      if (parent.rootSessionId !== summary.rootSessionId) {
        throw new SessionTreeIntegrityError(
          "root_mismatch",
          summary.sessionId,
          entry.filePath,
          `Session "${summary.sessionId}" declares root "${summary.rootSessionId}" but parent "${parentSessionId}" belongs to "${parent.rootSessionId}"`,
        );
      }

      const cycle = findParentCycle(summary.sessionId, summary.rootSessionId, sessions);
      if (cycle.length > 0) {
        throw new SessionTreeIntegrityError(
          "cycle",
          summary.sessionId,
          entry.filePath,
          `Cycle detected in session tree: ${cycle.join(" -> ")}`,
        );
      }
    }

    const childrenByParent = new Map<string, SessionSummary[]>();
    for (const { summary } of parsedEntries) {
      if (summary.rootSessionId !== rootSessionId || summary.parentSessionId === undefined) continue;
      const siblings = childrenByParent.get(summary.parentSessionId) ?? [];
      siblings.push(summary);
      childrenByParent.set(summary.parentSessionId, siblings);
    }

    attachChildren(rootNode, childrenByParent);
    return { root: rootNode, diagnostics: [] };
  }

  async listSessionFamilyToolBatchHitlIds(workspaceRoot: string, rootSessionId: string): Promise<string[]> {
    const tree = await this.buildSessionTree(workspaceRoot, rootSessionId);
    const sessionIds = collectSessionTreeIds(tree.root);
    const blocked = new Set<string>();
    for (const sessionId of sessionIds) {
      const session = await this.getSessionFile(workspaceRoot, sessionId);
      const activeBatch = session.toolBatches.find((batch) => batch.archivedAt === undefined);
      for (const hitlId of activeBatch?.calls.flatMap((call) => call.state === "blocked" && call.blocker?.hitlId !== undefined ? [call.blocker.hitlId] : []) ?? []) {
        blocked.add(hitlId);
      }
    }
    return [...blocked].sort();
  }

  async #loadFromDisk(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<StoreApi<SessionStoreState>> {
    const rootSessionId = await this.resolveRootSessionId(sessionId, workspaceRoot);
    const parsed = reconcileInterruptedSessionFile(await sessionFileInternals.readSessionFile(sessionId, workspaceRoot, rootSessionId));

    // Re-check registry after I/O: a concurrent create() may have registered
    // a store for this key while we were reading from disk. If so, return it
    // without overwriting live state with stale disk data.
    const key = this.key(sessionId, workspaceRoot);
    const existing = this.#registry.get(key);
    if (existing) return existing;

    this.#hydrating.add(key);
    try {
      const store = this.create(sessionId, workspaceRoot, {
        cwd: parsed.cwd,
        rootSessionId: parsed.rootSessionId,
        parentSessionId: parsed.parentSessionId,
        goalId: parsed.goalId,
        sessionRole: parsed.sessionRole,
        agentName: parsed.agentName,
        activeSkillNames: parsed.activeSkillNames,
        modelSelection: parsed.modelSelection,
        ...(parsed.title === null ? {} : { title: parsed.title }),
      });
      store.setState({
        sessionId: parsed.sessionId,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        cwd: parsed.cwd,
        agentName: parsed.agentName,
        activeSkillNames: parsed.activeSkillNames,
        modelSelection: parsed.modelSelection,
        title: parsed.title,
        messages: parsed.messages,
        pendingMessages: parsed.pendingMessages,
        queueDispatchBarrierAt: parsed.queueDispatchBarrierAt,
        inputRequestReceipts: parsed.inputRequestReceipts,
        steps: parsed.steps,
        stats: parsed.stats,
        executions: parsed.executions,
        compression: parsed.compression,
        executionCount: parsed.executions.length,
        todos: parsed.todos,
        reminders: parsed.reminders,
        childSessionLinks: parsed.childSessionLinks,
        toolBatches: parsed.toolBatches,
        rootSessionId: parsed.rootSessionId,
        parentSessionId: parsed.parentSessionId,
        goalId: parsed.goalId,
        sessionRole: parsed.sessionRole,
        isRunning: false,
        isStreamingModel: false,
        currentExecutionId: undefined,
        currentAssistantMessageId: undefined,
        readSnapshots: new Map(),
        events: parsed.events ?? [],
        eventOffset: eventOffsetFromEvents(parsed.events ?? []),
        nextEventId: nextEventIdFromEvents(parsed.events ?? []),
        publishableNextEventId: nextEventIdFromEvents(parsed.events ?? []),
      });
      this.#registerRootSessionId(parsed.sessionId, workspaceRoot, parsed.rootSessionId);

      return store;
    } finally {
      this.#hydrating.delete(key);
    }
  }

  delete(sessionId: string, workspaceRoot: string, options: { forgetWorkspaceIndex?: boolean } = {}): boolean {
    // Runtime deletion should unlink named workflow participants before removing
    // session stores/files. The workflow state manager is project-scoped, so that
    // cross-resource cleanup is wired by the runtime/execution layer rather than
    // this store-only registry.
    const key = this.key(sessionId, workspaceRoot);
    const removed = this.#registry.delete(key);
    this.#pendingPersists.delete(key);
    this.#persistFailures.delete(key);
    this.#publicationBarriers.delete(key);
    if (options.forgetWorkspaceIndex === true) this.#forgetWorkspaceIndex(workspaceRoot);
    else this.#forgetSessionIndex(sessionId, workspaceRoot);
    return removed;
  }

  releaseWorkspace(workspaceRoot: string): void {
    const prefix = `${workspaceRoot}\0`;
    for (const key of [...this.#registry.keys()]) {
      if (key.startsWith(prefix)) this.#registry.delete(key);
    }
    for (const key of [...this.#pendingLoads.keys()]) {
      if (key.startsWith(prefix)) this.#pendingLoads.delete(key);
    }
    for (const key of [...this.#pendingPersists.keys()]) {
      if (key.startsWith(prefix)) this.#pendingPersists.delete(key);
    }
    for (const key of [...this.#persistFailures.keys()]) {
      if (key.startsWith(prefix)) this.#persistFailures.delete(key);
    }
    for (const key of [...this.#publicationBarriers.keys()]) {
      if (key.startsWith(prefix)) this.#publicationBarriers.delete(key);
    }
    this.#forgetWorkspaceIndex(workspaceRoot);
    this.#scanPromiseByWorkspace.delete(workspaceRoot);
  }

  clearAll(): void {
    this.#registry.clear();
    this.#pendingLoads.clear();
    this.#pendingPersists.clear();
    this.#persistFailures.clear();
    this.#publicationBarriers.clear();
    this.#rootIdIndex.clear();
    this.#scanPromiseByWorkspace.clear();
  }

  has(sessionId: string, workspaceRoot: string): boolean {
    return this.#registry.has(this.key(sessionId, workspaceRoot));
  }

  async #isRootSessionOnDisk(sessionId: string, workspaceRoot: string): Promise<boolean> {
    try {
      const file = reconcileInterruptedSessionFile(await sessionFileInternals.readSessionFile(sessionId, workspaceRoot, sessionId));
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
    for (const summary of await sessionFileInternals.scanAllSessionSummaries(workspaceRoot)) {
      this.#registerRootSessionId(summary.sessionId, workspaceRoot, summary.rootSessionId);
    }
  }
}

function reduceStoreEvent(
  state: SessionStoreState,
  event: SessionEventPayload,
): Partial<SessionStoreState> {
  if (event.type !== "shutdown") return reduceStreamEvent(state, event);

  return {};
}

function appendEventToState(
  state: SessionStoreState,
  event: SessionEventPayload,
  publishImmediately: boolean,
): SessionStoreState {
  const envelope: SessionEventEnvelope = {
    id: state.nextEventId,
    createdAt: Date.now(),
    payload: event,
  };
  const events = [...state.events, envelope];
  let eventOffset = state.eventOffset;
  const nextEventId = state.nextEventId + 1;
  if (events.length > MAX_EVENTS) {
    const dropCount = Math.min(
      events.length - MAX_EVENTS,
      Math.max(0, state.publishableNextEventId - state.eventOffset),
    );
    events.splice(0, dropCount);
    eventOffset += dropCount;
  }
  return {
    ...state,
    ...reduceStoreEvent(state, event),
    events,
    eventOffset,
    nextEventId,
    publishableNextEventId: publishImmediately ? nextEventId : state.publishableNextEventId,
  };
}

function isDurableControlEvent(event: SessionEventPayload): boolean {
  return event.type === "session.message_accepted"
    || event.type === "session.message_edited"
    || event.type === "session.message_deleted"
    || event.type === "session.message_steer_claimed"
    || event.type === "session.message_steer_rolled_back"
    || event.type === "session.messages_committed"
    || event.type === "execution-start"
    || event.type === "execution-stop-requested"
    || event.type === "execution-end";
}

function nextEventIdFromEvents(events: readonly SessionEventEnvelope[]): number {
  const latest = events.at(-1);
  return latest === undefined ? 0 : latest.id + 1;
}

function eventOffsetFromEvents(events: readonly SessionEventEnvelope[]): number {
  return events.at(0)?.id ?? 0;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sameResolvedPath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function readDescendantSessionEntries(
  workspaceRoot: string,
  rootSessionId: string,
): Promise<Array<{ sessionId: string; filePath: string }>> {
  const dir = getSessionsDir(workspaceRoot);
  try {
    const entries: Array<{ sessionId: string; filePath: string }> = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === rootSessionId) continue;
      const filePath = join(dir, entry.name, "session.json");
      entries.push({ sessionId: entry.name, filePath });
    }
    return entries;
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function readSessionFileForTree(
  sessionId: string,
  filePath: string,
): Promise<HydratedSessionFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(filePath).text());
  } catch (error) {
    throw new SessionTreeIntegrityError(
      "invalid_json",
      sessionId,
      filePath,
      `Invalid session JSON in "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  const parsed = SessionFileSchema.safeParse(raw);
  if (parsed.success) return reconcileInterruptedSessionFile(parsed.data);

  throw new SessionTreeIntegrityError(
    "invalid_schema",
    readDiagnosticSessionId(raw) ?? sessionId,
    filePath,
    `Invalid session schema in "${filePath}": ${parsed.error.message}`,
    parsed.error,
  );
}

function readDiagnosticSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessionId = (value as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function toSessionSummary(file: HydratedSessionFile): SessionSummary {
  return {
    sessionId: file.sessionId,
    cwd: file.cwd,
    rootSessionId: file.rootSessionId,
    ...(file.parentSessionId === undefined ? {} : { parentSessionId: file.parentSessionId }),
    ...(file.goalId === undefined ? {} : { goalId: file.goalId }),
    ...(file.sessionRole === undefined ? {} : { sessionRole: file.sessionRole }),
    agentName: file.agentName,
    activeSkillNames: file.activeSkillNames,
    modelSelection: file.modelSelection,
    title: file.title,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

const TERMINAL_EXECUTION_STATUSES = new Set<HydratedSessionFile["executions"][number]["status"]>([
  "completed",
  "max_steps",
  "failed",
  "aborted",
  "cancelled",
  "timed_out",
  "interrupted",
  "waiting_for_human",
]);

const ACTIVE_CHILD_LINK_STATUSES = new Set(["linked", "running", "cancelling"]);

function reconcileInterruptedSessionFile(file: HydratedSessionFile): HydratedSessionFile {
  const now = Date.now();
  let changed = false;
  const executions = file.executions.map((execution) => {
    if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) return execution;
    changed = true;
    const endedAt = execution.endedAt ?? now;
    return {
      ...execution,
      status: "interrupted" as const,
      endedAt,
      durationMs: execution.durationMs ?? Math.max(0, endedAt - execution.startedAt),
      error: execution.error ?? "Execution interrupted by restart",
    };
  });
  const childSessionLinks = file.childSessionLinks.map((link) => {
    if (!ACTIVE_CHILD_LINK_STATUSES.has(link.status)) return link;
    changed = true;
    return {
      ...link,
      status: "interrupted" as const,
      endedAt: link.endedAt ?? now,
      error: link.error ?? "Child execution interrupted by restart",
    };
  });
  const messages = file.messages.map((message) => {
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if ((part.type === "text" || part.type === "reasoning") && part.completedAt === undefined) {
        changed = true;
        messageChanged = true;
        const partial = part as TextPart | ReasoningPart;
        return {
          ...partial,
          completedAt: now,
          meta: { ...(partial.meta ?? {}), interrupted: true, discardedFromContext: true },
        };
      }

      return part;
    });

    return messageChanged ? { ...message, parts, completedAt: message.completedAt ?? now } : message;
  });
  const inputRequestReceipts = file.inputRequestReceipts.map((receipt) => {
    if (receipt.kind !== "command" || receipt.status !== "executing") return receipt;
    changed = true;
    return {
      ...receipt,
      status: "indeterminate" as const,
      error: "Command outcome is unknown because execution was interrupted by restart",
    };
  });
  return changed ? { ...file, executions, childSessionLinks, messages, inputRequestReceipts } : file;
}

function findParentCycle(
  startSessionId: string,
  rootSessionId: string,
  sessions: Map<string, SessionSummary>,
): string[] {
  const path: string[] = [];
  const seenAt = new Map<string, number>();
  let cursor: string | undefined = startSessionId;

  while (cursor !== undefined && cursor !== rootSessionId) {
    const previous = seenAt.get(cursor);
    if (previous !== undefined) return path.slice(previous).concat(cursor);
    seenAt.set(cursor, path.length);
    path.push(cursor);
    cursor = sessions.get(cursor)?.parentSessionId;
  }

  return [];
}

function attachChildren(
  node: SessionTreeNode,
  childrenByParent: Map<string, SessionSummary[]>,
): void {
  const children = childrenByParent.get(node.session.sessionId) ?? [];
  node.children = children
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((session) => ({ session, children: [] }));
  for (const child of node.children) attachChildren(child, childrenByParent);
}
