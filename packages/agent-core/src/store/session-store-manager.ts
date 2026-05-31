import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ModelMessage } from "ai";
import { createEmptySessionStats } from "@specra/protocol";
import type {
  SessionTreeDiagnostic,
  SessionTreeDiagnosticType,
  SessionTreeNode,
  SessionTreeResponse,
} from "@specra/protocol";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Logger } from "../logger";
import { NotRootSessionError } from "./errors";
import { SessionFileSchema, sessionFileInternals, type SessionFile, type SessionSummary } from "./helpers";
import { toModelMessagesFromStoredMessages } from "./projection";
import { reduceStreamEvent } from "./reduce";
import { __hasSessionsDirOverrideForTest, getRootSessionDir, getSessionPath, getSessionsDir } from "./sessions-dir";
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

export interface CreateSessionOptions {
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly agentName?: string;
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
      agentName: options.agentName ?? "orchestrator",
      title: options.title ?? null,
      messages: [],
      steps: [],
      stats: createEmptySessionStats(),
      runs: [],
      todos: [],
      reminders: [],
      // Root/parent IDs are write-once session identity, not mutable tree state.
      rootSessionId,
      parentSessionId,
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
        const current = get().parentSessionId;
        if (current !== undefined) return; // Identity is immutable after creation
        set({ parentSessionId });
        persist();
      },
      toModelMessages: (): ModelMessage[] =>
        toModelMessagesFromStoredMessages(get().messages),
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

  async buildSessionTree(workspaceRoot: string, rootSessionId: string): Promise<SessionTreeResponse> {
    const rootFile = await sessionFileInternals.readSessionFile(rootSessionId, workspaceRoot, rootSessionId);
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

      if (parsed.sessionId !== entry.sessionId) {
        pushDiagnostic(diagnostics, "session_id_mismatch", parsed.sessionId, entry.filePath,
          `Session ID mismatch: expected "${entry.sessionId}", found "${parsed.sessionId}" in file`);
        continue;
      }
      if (parsed.rootSessionId !== rootSessionId) {
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
        pushDiagnostic(diagnostics, "missing_parent", summary.sessionId, getSessionPath(workspaceRoot, rootSessionId, summary.sessionId),
          `Parent session "${parentSessionId ?? "<missing>"}" for "${summary.sessionId}" was not found`);
      }
    }

    for (const summary of sessions.values()) {
      if (summary.sessionId === rootSessionId || invalidIds.has(summary.sessionId)) continue;
      const cycle = findParentCycle(summary.sessionId, rootSessionId, sessions);
      if (cycle.length === 0) continue;
      for (const cycleSessionId of cycle) invalidIds.add(cycleSessionId);
      pushDiagnostic(diagnostics, "cycle", summary.sessionId, getSessionPath(workspaceRoot, rootSessionId, summary.sessionId),
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
    const parsed = await sessionFileInternals.readSessionFile(sessionId, workspaceRoot, rootSessionId);

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
        ...(parsed.agentName === undefined ? {} : { agentName: parsed.agentName }),
        ...(parsed.title === undefined || parsed.title === null ? {} : { title: parsed.title }),
      });
      store.setState({
        sessionId: parsed.sessionId,
        createdAt: parsed.createdAt,
        agentName: parsed.agentName ?? "orchestrator",
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

  delete(sessionId: string, workspaceRoot?: string, options: { forgetWorkspaceIndex?: boolean } = {}): boolean {
    const removed = this.#registry.delete(this.key(sessionId, workspaceRoot));
    if (workspaceRoot !== undefined) {
      if (options.forgetWorkspaceIndex === true) this.#forgetWorkspaceIndex(workspaceRoot);
      else this.#forgetSessionIndex(sessionId, workspaceRoot);
    }
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

async function readDescendantSessionEntries(
  workspaceRoot: string,
  rootSessionId: string,
): Promise<Array<{ sessionId: string; filePath: string }>> {
  const dir = getRootSessionDir(workspaceRoot, rootSessionId);
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => ({
        sessionId: basename(entry.name, ".json"),
        filePath: join(dir, entry.name),
      }));
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
): Promise<SessionFile | undefined> {
  return await readRawSessionFileForTree(sessionId, filePath, diagnostics);
}

async function readRawSessionFileForTree(
  sessionId: string,
  filePath: string,
  diagnostics: SessionTreeDiagnostic[],
): Promise<SessionFile | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(filePath).text());
  } catch (error) {
    pushDiagnostic(diagnostics, "invalid_json", sessionId, filePath,
      `Invalid session JSON in "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const parsed = SessionFileSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  pushDiagnostic(diagnostics, "invalid_json", readDiagnosticSessionId(raw) ?? sessionId, filePath,
    `Invalid session JSON in "${filePath}": ${parsed.error.message}`);
  return undefined;
}

function readDiagnosticSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessionId = (value as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function toSessionSummary(file: SessionFile): SessionSummary {
  const lastUpdatedAt = readLastUpdatedAt(file);
  return {
    sessionId: file.sessionId,
    rootSessionId: file.rootSessionId,
    ...(file.parentSessionId === undefined ? {} : { parentSessionId: file.parentSessionId }),
    agentName: file.agentName ?? null,
    title: file.title ?? null,
    createdAt: file.createdAt,
    ...(lastUpdatedAt === undefined ? {} : { lastUpdatedAt }),
  };
}

function readLastUpdatedAt(file: SessionFile): number | undefined {
  const record = file as SessionFile & { lastUpdatedAt?: unknown; updatedAt?: unknown };
  if (typeof record.lastUpdatedAt === "number") return record.lastUpdatedAt;
  if (typeof record.updatedAt === "number") return record.updatedAt;
  return undefined;
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
