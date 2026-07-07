import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ModelMessage } from "ai";
import { createEmptySessionStats } from "@archcode/protocol";
import { createEmptyCompressionState, resolveCompressionOriginalRange, type CompressionOriginalRangeResult } from "../compression";
import type {
  SessionModelInfo,
  SessionTreeDiagnostic,
  SessionTreeDiagnosticType,
  SessionTreeNode,
  SessionTreeResponse,
} from "@archcode/protocol";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger";
import { NotRootSessionError, SessionFileNotFoundError } from "./errors";
import { SessionFileSchema, sessionFileInternals, type HydratedSessionFile, type SessionSummary } from "./helpers";
import { projectModelMessagesFromStoredMessages } from "./projection";
import { reduceStreamEvent } from "./reduce";
import { __hasSessionsDirOverrideForTest, getSessionPath, getSessionsDir } from "./sessions-dir";
import {
  type ReasoningPart,
  type SessionEventEnvelope,
  type SessionEventPayload,
  type SessionRole,
  type SessionStoreState,
  type StreamEvent,
  type PendingInteraction,
  type TextPart,
  MAX_EVENTS,
} from "./types";

export interface SessionStoreManagerOptions {
  readonly logger: Logger;
}

export interface CreateSessionOptions {
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly goalId?: string;
  readonly loopId?: string;
  readonly sessionRole?: SessionRole;
  readonly agentName?: string;
  readonly modelInfo?: SessionModelInfo | null;
  readonly title?: string;
}

export class SessionStoreManager {
  #registry = new Map<string, StoreApi<SessionStoreState>>();
  #pendingLoads = new Map<string, Promise<StoreApi<SessionStoreState>>>();
  #pendingPersists = new Map<string, Promise<void>>();
  #hydrating = new Set<string>();
  // Disposable acceleration for child lookups; source of truth stays on disk.
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

  #forgetSessionIndex(sessionId: string, workspaceRoot: string): void {
    this.#rootIdIndex.delete(this.indexKey(sessionId, workspaceRoot));
  }

  create(sessionId: string, workspaceRoot?: string, options: CreateSessionOptions = {}): StoreApi<SessionStoreState> {
    const key = this.key(sessionId, workspaceRoot);
    const existing = this.#registry.get(key);
    if (existing) return existing;

    const shouldPersist = workspaceRoot !== undefined || __hasSessionsDirOverrideForTest();
    const persistWorkspaceRoot = workspaceRoot ?? "__test__";
    const rootSessionId = options.rootSessionId ?? sessionId;
    const parentSessionId = options.parentSessionId;
    const goalId = options.goalId;
    const loopId = options.loopId;
    const sessionRole = options.sessionRole;
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
      if (
        event.type === "user-message"
        || event.type === "execution-end"
        || event.type === "tool-attempt"
        || event.type === "tool-result"
        || event.type === "llm-retry"
        || event.type === "llm-recovery"
        || event.type === "llm-recovery-failed"
        || event.type === "compact"
        || event.type === "tool-child-session-link"
        || event.type === "question.request"
        || event.type === "question.terminal"
        || event.type === "loop-error"
        || event.type === "compression.block_committed"
        || event.type === "compression.block_failed"
        || event.type === "compression.ref_map_updated"
      ) persist();
    };

    store = createStore<SessionStoreState>((set, get) => ({
      sessionId,
      createdAt: Date.now(),
      agentName: options.agentName ?? "orchestrator",
      modelInfo: options.modelInfo ?? null,
      title: options.title ?? null,
      messages: [],
      steps: [],
      stats: createEmptySessionStats(),
      executions: [],
      compression: createEmptyCompressionState(),
      todos: [],
      pendingInteractions: [],
      reminders: [],
      childSessionLinks: [],
      // Root/parent IDs are write-once session identity, not mutable tree state.
      rootSessionId,
      parentSessionId,
      goalId,
      loopId,
      sessionRole,
      blockedHitl: undefined,
      blockedByHitlIds: undefined,
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

          const partial = reduceStoreEvent(state, event as SessionEventPayload);

          return { ...partial, events, eventOffset, nextEventId };
        });
        persistForEvent(event);
      },
      addPendingInteraction: (interaction: PendingInteraction) => {
        set((state) => ({ pendingInteractions: upsertPendingInteraction(state.pendingInteractions ?? [], interaction) }));
        persist();
      },
      answerPendingInteraction: (questionId: string, answer: string, answeredAt = new Date().toISOString()) => {
        set((state) => ({ pendingInteractions: answerPendingInteraction(state.pendingInteractions ?? [], questionId, answer, answeredAt) }));
        persist();
      },
      expirePendingInteractions: (questionIds?: string[], expiredAt = new Date().toISOString()) => {
        void expiredAt;
        set((state) => ({ pendingInteractions: expirePendingInteractions(state.pendingInteractions ?? [], questionIds) }));
        persist();
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
      setLoopId: (loopId: string | undefined) => {
        set({ loopId });
        persist();
      },
      setSessionRole: (sessionRole: SessionRole | undefined) => {
        set({ sessionRole });
        persist();
      },
      toModelMessages: (): ModelMessage[] => {
        const state = get();
        const compression = state.compression ?? createEmptyCompressionState();
        const projection = projectModelMessagesFromStoredMessages(state.messages, { compression });
        if (projection.refMap !== undefined && projection.refMap !== compression.refMap) {
          set({ compression: { ...compression, refMap: projection.refMap, updatedAt: Date.now() } });
          persist();
        }
        return projection.messages;
      },
    }));

    this.#registry.set(key, store);
    if (shouldPersist) this.#registerRootSessionId(sessionId, persistWorkspaceRoot, rootSessionId);
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

  async createSessionFile(workspaceRoot: string, options: CreateSessionOptions = {}): Promise<HydratedSessionFile> {
    const store = this.create(crypto.randomUUID(), workspaceRoot, options);
    return sessionFileInternals.toSessionFile(store.getState());
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

  async setGoalId(sessionId: string, goalId: string | undefined, workspaceRoot?: string): Promise<SessionStoreState> {
    const store = workspaceRoot === undefined
      ? this.findLoadedSession(sessionId)
      : await this.getOrLoad(sessionId, workspaceRoot);

    if (store === undefined) throw new SessionFileNotFoundError(sessionId);
    store.getState().setGoalId(goalId);
    return store.getState();
  }

  appendSessionEvent(sessionId: string, event: SessionEventPayload, workspaceRoot?: string): boolean {
    const store = workspaceRoot === undefined
      ? this.findLoadedSession(sessionId)
      : this.get(sessionId, workspaceRoot);
    if (store === undefined) return false;

    store.getState().append(event);
    return true;
  }

  private findLoadedSession(sessionId: string): StoreApi<SessionStoreState> | undefined {
    const direct = this.#registry.get(sessionId);
    if (direct !== undefined) return direct;

    const suffix = `\0${sessionId}`;
    for (const [key, store] of this.#registry.entries()) {
      if (key.endsWith(suffix)) return store;
    }

    return undefined;
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

    throw new SessionFileNotFoundError(sessionId);
  }

  async listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
    return await sessionFileInternals.listSessionSummaries(workspaceRoot);
  }

  async buildSessionTree(workspaceRoot: string, rootSessionId: string): Promise<SessionTreeResponse> {
    const rootFile = reconcileInterruptedSessionFile(await sessionFileInternals.readSessionFile(rootSessionId, workspaceRoot, rootSessionId));
    if (rootFile.parentSessionId !== undefined) {
      throw new NotRootSessionError(rootSessionId, rootFile.parentSessionId);
    }

    const diagnostics: SessionTreeDiagnostic[] = [];
    const rootNode: SessionTreeNode = { session: toSessionSummary(rootFile), children: [] };
    const sessions = new Map<string, SessionSummary>([[rootSessionId, rootNode.session]]);
    const childrenByParent = new Map<string, SessionSummary[]>();

    await sessionFileInternals.scanDescendants(workspaceRoot, rootSessionId);

    for (const entry of await readDescendantSessionEntries(workspaceRoot, rootSessionId)) {
      const parsed = await readSessionFileForTree(entry.sessionId, workspaceRoot, rootSessionId, entry.filePath, diagnostics);
      if (parsed === undefined) continue;

      if (parsed.rootSessionId !== rootSessionId) {
        if (parsed.parentSessionId === undefined && parsed.rootSessionId === parsed.sessionId) continue;
        pushDiagnostic(diagnostics, "root_mismatch", parsed.sessionId, entry.filePath,
          `Root session ID mismatch: expected "${rootSessionId}", found "${parsed.rootSessionId}" in file`);
        continue;
      }
      if (parsed.parentSessionId === undefined) {
        pushDiagnostic(diagnostics, "not_root", parsed.sessionId, entry.filePath,
          `Descendant session "${parsed.sessionId}" does not declare a parent session`);
        continue;
      }
      if (sessions.has(parsed.sessionId)) {
        pushDiagnostic(diagnostics, "duplicate_session", parsed.sessionId, entry.filePath,
          `Duplicate session ID "${parsed.sessionId}" found while building tree`);
        continue;
      }
      if (parsed.sessionId !== entry.sessionId) {
        pushDiagnostic(diagnostics, "session_id_mismatch", parsed.sessionId, entry.filePath,
          `Session ID mismatch: expected "${entry.sessionId}", found "${parsed.sessionId}" in file`);
        continue;
      }

      const summary = toSessionSummary(parsed);
      sessions.set(summary.sessionId, summary);
      const parentSessionId = parsed.parentSessionId;
      const siblings = childrenByParent.get(parentSessionId) ?? [];
      siblings.push(summary);
      childrenByParent.set(parentSessionId, siblings);
    }

    const invalidIds = new Set<string>();
    for (const summary of sessions.values()) {
      if (summary.sessionId === rootSessionId) continue;
      const parentSessionId = summary.parentSessionId;
      if (parentSessionId === undefined || !sessions.has(parentSessionId)) {
        invalidIds.add(summary.sessionId);
        pushDiagnostic(diagnostics, "missing_parent", summary.sessionId, getSessionPath(workspaceRoot, summary.sessionId),
          `Parent session "${parentSessionId ?? "<missing>"}" for "${summary.sessionId}" was not found`);
      }
    }

    for (const summary of sessions.values()) {
      if (summary.sessionId === rootSessionId || invalidIds.has(summary.sessionId)) continue;
      const cycle = findParentCycle(summary.sessionId, rootSessionId, sessions);
      if (cycle.length === 0) continue;
      for (const cycleSessionId of cycle) invalidIds.add(cycleSessionId);
      pushDiagnostic(diagnostics, "cycle", summary.sessionId, getSessionPath(workspaceRoot, summary.sessionId),
        `Cycle detected in session tree: ${cycle.join(" -> ")}`);
    }

    attachChildren(rootNode, childrenByParent, invalidIds);
    return { root: rootNode, diagnostics };
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
        rootSessionId: parsed.rootSessionId,
        parentSessionId: parsed.parentSessionId,
        goalId: parsed.goalId,
        loopId: parsed.loopId,
        sessionRole: parsed.sessionRole,
        agentName: parsed.agentName,
        ...(parsed.modelInfo === undefined ? {} : { modelInfo: parsed.modelInfo }),
        ...(parsed.title === undefined || parsed.title === null ? {} : { title: parsed.title }),
      });
      store.setState({
        sessionId: parsed.sessionId,
        createdAt: parsed.createdAt,
        agentName: parsed.agentName,
        modelInfo: parsed.modelInfo ?? null,
        title: parsed.title ?? null,
        messages: parsed.messages,
        steps: parsed.steps,
        stats: parsed.stats,
        executions: parsed.executions,
        compression: parsed.compression,
        executionCount: parsed.executions.length,
        todos: parsed.todos ?? [],
        pendingInteractions: parsed.pendingInteractions,
        reminders: parsed.reminders,
        childSessionLinks: parsed.childSessionLinks,
        rootSessionId: parsed.rootSessionId,
        parentSessionId: parsed.parentSessionId,
        goalId: parsed.goalId,
        loopId: parsed.loopId,
        sessionRole: parsed.sessionRole,
        blockedHitl: parsed.blockedHitl,
        blockedByHitlIds: parsed.blockedByHitlIds,
        isRunning: false,
        isStreamingModel: false,
        currentExecutionId: undefined,
        currentAssistantMessageId: undefined,
        readSnapshots: new Map(),
        events: parsed.events ?? [],
        eventOffset: 0,
        nextEventId: nextEventIdFromEvents(parsed.events ?? []),
      });
      this.#registerRootSessionId(parsed.sessionId, workspaceRoot, parsed.rootSessionId);

      return store;
    } finally {
      this.#hydrating.delete(key);
    }
  }

  delete(sessionId: string, workspaceRoot?: string, options: { forgetWorkspaceIndex?: boolean } = {}): boolean {
    // Runtime deletion should unlink named workflow participants before removing
    // session stores/files. The workflow state manager is project-scoped, so that
    // cross-resource cleanup is wired by the runtime/execution layer rather than
    // this store-only registry.
    const removed = this.#registry.delete(this.key(sessionId, workspaceRoot));
    if (workspaceRoot !== undefined) {
      if (options.forgetWorkspaceIndex === true) this.#forgetWorkspaceIndex(workspaceRoot);
      else this.#forgetSessionIndex(sessionId, workspaceRoot);
    }
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
    this.#forgetWorkspaceIndex(workspaceRoot);
    this.#scanPromiseByWorkspace.delete(workspaceRoot);
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
  if (event.type === "question.request") {
    return {
      pendingInteractions: upsertPendingInteraction(state.pendingInteractions ?? [], {
        id: event.questionId,
        type: event.questionType ?? "clarification",
        question: event.question,
        ...(event.context === undefined ? {} : { context: event.context }),
        askedAt: new Date().toISOString(),
        status: "pending",
      }),
    };
  }

  if (event.type === "question.terminal") {
    if (event.status === "resolved" && event.answer !== undefined) {
      return {
        pendingInteractions: answerPendingInteraction(
          state.pendingInteractions ?? [],
          event.questionId,
          event.answer,
          new Date().toISOString(),
        ),
      };
    }

    return {
      pendingInteractions: expirePendingInteractions(state.pendingInteractions ?? [], [event.questionId]),
    };
  }

  if (isStreamEvent(event)) return reduceStreamEvent(state, event);

  return {};
}

function isStreamEvent(event: SessionEventPayload): event is StreamEvent {
  return STREAM_EVENT_TYPES.has(event.type as StreamEvent["type"]);
}

const STREAM_EVENT_TYPES = new Set<StreamEvent["type"]>([
  "execution-start",
  "execution-end",
  "user-message",
  "system-notice",
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-call",
  "tool-input-resolved",
  "tool-attempt",
  "tool-result",
  "tool-child-session-link",
  "step-start",
  "step-end",
  "loop-error",
  "todo-write",
  "reminder",
  "reminder-consumed",
  "llm-retry",
  "llm-recovery",
  "llm-recovery-failed",
  "compression.block_committed",
  "compression.block_failed",
  "compression.ref_map_updated",
  "goal.state_change",
  "goal.done_check",
  "goal.escalation",
  "hitl.request",
  "hitl.resolved",
  "loop.state_change",
  "loop.run_appended",
  "compact",
]);

function nextEventIdFromEvents(events: readonly SessionEventEnvelope[]): number {
  const latest = events.at(-1);
  return latest === undefined ? 0 : latest.id + 1;
}

function upsertPendingInteraction(
  interactions: readonly PendingInteraction[],
  interaction: PendingInteraction,
): PendingInteraction[] {
  const index = interactions.findIndex((entry) => entry.id === interaction.id);
  if (index === -1) return [...interactions, interaction];
  return interactions.map((entry, currentIndex) => currentIndex === index ? interaction : entry);
}

function answerPendingInteraction(
  interactions: readonly PendingInteraction[],
  questionId: string,
  answer: string,
  answeredAt: string,
): PendingInteraction[] {
  return interactions.map((interaction) => interaction.id === questionId
    ? { ...interaction, status: "answered", answer: { content: answer, answeredAt } }
    : interaction,
  );
}

function expirePendingInteractions(
  interactions: readonly PendingInteraction[],
  questionIds?: readonly string[],
): PendingInteraction[] {
  const ids = questionIds === undefined ? undefined : new Set(questionIds);
  return interactions.map((interaction) => {
    if (ids !== undefined && !ids.has(interaction.id)) return interaction;
    if (interaction.status !== "pending") return interaction;
    return { ...interaction, status: "expired" };
  });
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
  _workspaceRoot: string,
  _rootSessionId: string,
  filePath: string,
  diagnostics: SessionTreeDiagnostic[],
): Promise<HydratedSessionFile | undefined> {
  return await readRawSessionFileForTree(sessionId, filePath, diagnostics);
}

async function readRawSessionFileForTree(
  sessionId: string,
  filePath: string,
  diagnostics: SessionTreeDiagnostic[],
): Promise<HydratedSessionFile | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(filePath).text());
  } catch (error) {
    pushDiagnostic(diagnostics, "invalid_json", sessionId, filePath,
      `Invalid session JSON in "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const parsed = SessionFileSchema.safeParse(raw);
    if (parsed.success) return reconcileInterruptedSessionFile(parsed.data);

  pushDiagnostic(diagnostics, "invalid_json", readDiagnosticSessionId(raw) ?? sessionId, filePath,
    `Invalid session JSON in "${filePath}": ${parsed.error.message}`);
  return undefined;
}

function readDiagnosticSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessionId = (value as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function toSessionSummary(file: HydratedSessionFile): SessionSummary {
  const lastUpdatedAt = readLastUpdatedAt(file);
  return {
    sessionId: file.sessionId,
    rootSessionId: file.rootSessionId,
    ...(file.parentSessionId === undefined ? {} : { parentSessionId: file.parentSessionId }),
    ...(file.goalId === undefined ? {} : { goalId: file.goalId }),
    ...(file.loopId === undefined ? {} : { loopId: file.loopId }),
    ...(file.sessionRole === undefined ? {} : { sessionRole: file.sessionRole }),
    agentName: file.agentName,
    ...(file.modelInfo === undefined ? {} : { modelInfo: file.modelInfo }),
    title: file.title ?? null,
    createdAt: file.createdAt,
    ...(lastUpdatedAt === undefined ? {} : { lastUpdatedAt }),
  };
}

function readLastUpdatedAt(file: HydratedSessionFile): number | undefined {
  const record = file as HydratedSessionFile & { lastUpdatedAt?: unknown; updatedAt?: unknown };
  if (typeof record.lastUpdatedAt === "number") return record.lastUpdatedAt;
  if (typeof record.updatedAt === "number") return record.updatedAt;
  return undefined;
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

      if (
        part.type !== "tool"
        || (part.state !== "pending" && part.state !== "running")
        || part.attemptId === undefined
      ) {
        return part;
      }

      changed = true;
      messageChanged = true;
      return {
        ...part,
        state: "error" as const,
        input: "input" in part ? part.input : undefined,
        startedAt: "startedAt" in part ? part.startedAt : now,
        endedAt: now,
        errorMessage: "Tool execution result unknown: execution was interrupted",
        meta: { unknownResult: true },
      };
    });

    return messageChanged ? { ...message, parts, completedAt: message.completedAt ?? now } : message;
  });
  return changed ? { ...file, executions, childSessionLinks, messages } : file;
}

function pushDiagnostic(
  diagnostics: SessionTreeDiagnostic[],
  type: SessionTreeDiagnosticType,
  sessionId: string | undefined,
  filePath: string | undefined,
  message: string,
): void {
  diagnostics.push({
    type,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(filePath === undefined ? {} : { filePath }),
    message,
  });
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
  invalidIds: Set<string>,
): void {
  const children = childrenByParent.get(node.session.sessionId) ?? [];
  node.children = children
    .filter((child) => !invalidIds.has(child.sessionId))
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((session) => ({ session, children: [] }));
  for (const child of node.children) attachChildren(child, childrenByParent, invalidIds);
}
