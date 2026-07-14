import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats, type CompressionBlockSnapshot, type HitlRecord, type SessionProjection } from "@archcode/protocol";
import { createEmptyCompressionState } from "../compression";
import { SessionStoreManager } from "./session-store-manager";
import { NotRootSessionError, SessionInitialPersistenceError, SessionTreeIntegrityError } from "./errors";
import { SessionFileIdentityConflictError } from "./session-store-manager";
import { sessionFileInternals } from "./helpers";
import { silentLogger } from "../logger";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "session-store-manager", crypto.randomUUID());

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("SessionStoreManager", () => {
  function sessionId(): string {
    return crypto.randomUUID();
  }

  function compressionBlockSnapshot(): CompressionBlockSnapshot {
    return {
      id: "block-1",
      ref: "b1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "model_tool_call",
      range: { startMessageId: "msg-1", endMessageId: "msg-2", startRef: "m0001", endRef: "m0002", startIndex: 0, endIndex: 1 },
      summary: "Persisted compression summary",
      childBlockRefs: [],
      protectedRefs: ["m0002"],
      tokenEstimate: { originalTokens: 100, summaryTokens: 25, savedTokens: 75, estimatedAt: 1234 },
      createdAt: 1000,
      updatedAt: 1001,
    };
  }

  type PersistedSessionState = Parameters<typeof sessionFileInternals.saveSessionTranscript>[0];

  function persistedSession(
    id: string,
    overrides: Partial<PersistedSessionState> = {},
  ): PersistedSessionState {
    return {
      sessionId: id,
      createdAt: 1000,
      updatedAt: 1000,
      cwd: TMP_DIR,
      agentName: "engineer",
      modelInfo: null,
      title: null,
      messages: [],
      steps: [],
      stats: createEmptySessionStats(),
      executions: [],
      compression: createEmptyCompressionState(),
      todos: [],
      reminders: [],
      childSessionLinks: [],
      rootSessionId: id,
      ...overrides,
    };
  }

  test("createSessionFile does not publish a Session before its initial snapshot is durable", async () => {
    const originalSave = sessionFileInternals.saveSessionTranscript;
    let releaseSave!: () => void;
    const saveReleased = new Promise<void>((resolve) => { releaseSave = resolve; });
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      markSaveStarted();
      await saveReleased;
      await originalSave(state, workspaceRoot);
    };

    try {
      const manager = new SessionStoreManager({ logger: silentLogger });
      let settled = false;
      const createdPromise = manager.createSessionFile(TMP_DIR, { agentName: "engineer" }).finally(() => { settled = true; });
      await saveStarted;
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseSave();
      const created = await createdPromise;
      expect(await Bun.file(join(TMP_DIR, ".archcode", "sessions", created.sessionId, "session.json")).exists()).toBe(true);
    } finally {
      releaseSave();
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("createSessionFile propagates initial persistence failure and retracts the in-memory identity", async () => {
    const originalSave = sessionFileInternals.saveSessionTranscript;
    const failure = new Error("simulated initial persistence failure");
    sessionFileInternals.saveSessionTranscript = async () => {
      throw failure;
    };

    try {
      const manager = new SessionStoreManager({ logger: silentLogger });
      let captured: unknown;
      try {
        await manager.createSessionFile(TMP_DIR, { goalId: crypto.randomUUID(), sessionRole: "main", agentName: "goal_lead" });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(SessionInitialPersistenceError);
      const persistenceError = captured as SessionInitialPersistenceError;
      expect(persistenceError.cause).toBe(failure);
      expect(manager.has(persistenceError.sessionId, TMP_DIR)).toBe(false);
      expect(await Bun.file(join(TMP_DIR, ".archcode", "sessions", persistenceError.sessionId, "session.json")).exists()).toBe(false);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("ensureSessionFile creates a caller-selected durable Session identity", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const goalId = sessionId();

    const created = await manager.ensureSessionFile(TMP_DIR, id, {
      agentName: "goal_lead",
      rootSessionId: id,
      goalId,
      sessionRole: "main",
      cwd: TMP_DIR,
    });

    expect(created).toMatchObject({
      sessionId: id,
      rootSessionId: id,
      agentName: "goal_lead",
      goalId,
      sessionRole: "main",
      cwd: TMP_DIR,
    });
    expect((await manager.getSessionFile(TMP_DIR, id)).sessionId).toBe(id);
  });

  test("ensureSessionFile verifies an existing stable identity without overwriting it", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const goalId = sessionId();
    const options = {
      agentName: "goal_lead" as const,
      rootSessionId: id,
      goalId,
      sessionRole: "main" as const,
      cwd: TMP_DIR,
    };
    const first = await manager.ensureSessionFile(TMP_DIR, id, options);

    await expect(manager.ensureSessionFile(TMP_DIR, id, options)).resolves.toEqual(first);
    await expect(manager.ensureSessionFile(TMP_DIR, id, {
      ...options,
      goalId: sessionId(),
    })).rejects.toBeInstanceOf(SessionFileIdentityConflictError);

    expect((await manager.getSessionFile(TMP_DIR, id)).goalId).toBe(goalId);
  });

  test("a background persistence failure poisons the Session until it is reloaded", async () => {
    const originalSave = sessionFileInternals.saveSessionTranscript;
    const failure = new Error("simulated background persistence failure");
    sessionFileInternals.saveSessionTranscript = async () => {
      throw failure;
    };

    try {
      const manager = new SessionStoreManager({ logger: silentLogger });
      const id = sessionId();
      const store = manager.create(id, TMP_DIR, { agentName: "engineer" });

      await expect(manager.flushSession(id, TMP_DIR)).rejects.toBe(failure);
      sessionFileInternals.saveSessionTranscript = originalSave;
      store.getState().setTitle("must not bypass the failed durable queue");
      await expect(manager.flushSession(id, TMP_DIR)).rejects.toBe(failure);
      expect(await Bun.file(canonicalSessionPath(id)).exists()).toBe(false);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  async function writeSessionFile(input: {
    sessionId: string;
    rootSessionId?: string;
    parentSessionId?: string;
    title?: string | null;
    createdAt?: number;
    blockedByHitlIds?: string[];
  }): Promise<void> {
    await sessionFileInternals.saveSessionTranscript(
      persistedSession(input.sessionId, {
        createdAt: input.createdAt ?? 1000,
        updatedAt: input.createdAt ?? 1000,
        agentName: input.parentSessionId === undefined ? "engineer" : "explore",
        title: input.title ?? null,
        rootSessionId: input.rootSessionId ?? input.sessionId,
        ...(input.blockedByHitlIds === undefined ? {} : { blockedByHitlIds: input.blockedByHitlIds }),
        ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      }),
      TMP_DIR,
    );
  }

  async function waitForFile(path: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await Bun.file(path).exists()) return;
      await Bun.sleep(1);
    }
    throw new Error(`Timed out waiting for file: ${path}`);
  }

  async function readSessionJson(path: string): Promise<Record<string, unknown>> {
    await waitForFile(path);
    return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
  }

  function canonicalSessionPath(sessionId: string): string {
    return join(TMP_DIR, ".archcode", "sessions", sessionId, "session.json");
  }

  async function writeRawSessionFile(sessionId: string, content: string): Promise<void> {
    await mkdir(join(TMP_DIR, ".archcode", "sessions", sessionId), { recursive: true });
    await Bun.write(canonicalSessionPath(sessionId), content);
  }

  async function waitForSessionJson(
    path: string,
    predicate: (json: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    let lastJson: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await Bun.file(path).exists()) {
        lastJson = await readSessionJson(path);
        if (predicate(lastJson)) return lastJson;
      }
      await Bun.sleep(1);
    }
    throw new Error(`Timed out waiting for matching session JSON: ${path}`);
  }

  test("create() returns the same store for the same sessionId+workspaceRoot", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store1 = manager.create(id, TMP_DIR, { agentName: "engineer" });
    const store2 = manager.create(id, TMP_DIR, { agentName: "engineer" });
    expect(store1).toBe(store2);
  });

  test("create() returns different stores for different sessionIds", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store1 = manager.create(sessionId(), TMP_DIR, { agentName: "engineer" });
    const store2 = manager.create(sessionId(), TMP_DIR, { agentName: "engineer" });
    expect(store1).not.toBe(store2);
  });

  test("create() defaults child session links to empty", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store = manager.create(sessionId(), TMP_DIR, { agentName: "engineer" });

    expect(store.getState().childSessionLinks).toEqual([]);
  });

  test("create() defaults cwd to the canonical workspace root", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store = manager.create(sessionId(), TMP_DIR, { agentName: "engineer" });

    expect(store.getState().cwd).toBe(TMP_DIR);
  });

  test("every durable snapshot advances the canonical updatedAt", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });
    await manager.flushSession(id, TMP_DIR);
    const first = await readSessionJson(canonicalSessionPath(id));
    await Bun.sleep(2);

    store.getState().setTitle("updated");
    await manager.flushSession(id, TMP_DIR);
    const second = await readSessionJson(canonicalSessionPath(id));

    expect(second.updatedAt).toBeGreaterThan(first.updatedAt as number);
    expect(store.getState().updatedAt).toBe(second.updatedAt as number);
  });

  test("persists an execution cwd independently from the canonical session directory", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const worktreeCwd = join(TMP_DIR, "..", "worktree");
    const store = manager.create(id, TMP_DIR, { cwd: worktreeCwd, agentName: "engineer" });

    expect(store.getState().cwd).toBe(worktreeCwd);
    const persisted = await waitForSessionJson(canonicalSessionPath(id), (json) => json.cwd === worktreeCwd);
    expect(persisted.cwd).toBe(worktreeCwd);

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    expect(loaded.getState().cwd).toBe(worktreeCwd);
    expect((await restarted.getSessionFile(TMP_DIR, id)).cwd).toBe(worktreeCwd);
    expect((await restarted.listSessionSummaries(TMP_DIR))[0]?.cwd).toBe(worktreeCwd);
  });

  test("updateCwd persists atomically in the canonical Session and clears read snapshots", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });
    store.getState().readSnapshots.set(join(TMP_DIR, "old.ts"), 1);
    const worktreeCwd = join(TMP_DIR, "..", "atomic-worktree");

    const observedCwds: string[] = [];
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.cwd !== previous.cwd) observedCwds.push(state.cwd);
    });
    await manager.updateCwd(id, TMP_DIR, worktreeCwd);
    unsubscribe();

    expect(store.getState().cwd).toBe(worktreeCwd);
    expect(store.getState().readSnapshots.size).toBe(0);
    expect(observedCwds).toEqual([worktreeCwd]);
    expect(store.getState().events.at(-1)?.payload).toEqual({
      type: "session.cwd_changed",
      previousCwd: TMP_DIR,
      cwd: worktreeCwd,
    });
    expect((await manager.getSessionFile(TMP_DIR, id)).cwd).toBe(worktreeCwd);
    expect((await manager.getSessionFile(TMP_DIR, id)).events?.at(-1)?.payload).toEqual({
      type: "session.cwd_changed",
      previousCwd: TMP_DIR,
      cwd: worktreeCwd,
    });
    expect(await Bun.file(join(worktreeCwd, ".archcode", "sessions", id, "session.json")).exists()).toBe(false);
    await expect(manager.updateCwd(id, TMP_DIR, "relative/path")).rejects.toMatchObject({ name: "InvalidSessionCwdError" });
  });

  test("updateCwd is an awaited barrier behind older queued Session snapshots", async () => {
    const originalSave = sessionFileInternals.saveSessionTranscript;
    let releaseFirstSave!: () => void;
    const firstSaveReleased = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let markFirstSaveStarted!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      markFirstSaveStarted = resolve;
    });
    let saveCount = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      saveCount += 1;
      if (saveCount === 1) {
        markFirstSaveStarted();
        await firstSaveReleased;
      }
      await originalSave(state, workspaceRoot);
    };

    try {
      const manager = new SessionStoreManager({ logger: silentLogger });
      const id = sessionId();
      const store = manager.create(id, TMP_DIR, { agentName: "engineer" });
      await firstSaveStarted;
      store.getState().setTitle("queued before cwd transition");
      const worktreeCwd = join(TMP_DIR, "..", "queued-worktree");

      const update = manager.updateCwd(id, TMP_DIR, worktreeCwd, TMP_DIR);
      releaseFirstSave();
      await update;

      const persisted = await waitForSessionJson(
        canonicalSessionPath(id),
        (json) => json.title === "queued before cwd transition",
      );
      expect(persisted.cwd).toBe(worktreeCwd);
      expect(persisted.title).toBe("queued before cwd transition");
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("updateCwd rejects a stale expected cwd without changing memory or disk", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });
    await waitForSessionJson(canonicalSessionPath(id), (json) => json.cwd === TMP_DIR);

    await expect(manager.updateCwd(id, TMP_DIR, join(TMP_DIR, "..", "next"), "/stale/cwd"))
      .rejects.toMatchObject({ name: "InvalidSessionCwdError" });

    expect(store.getState().cwd).toBe(TMP_DIR);
    expect((await readSessionJson(canonicalSessionPath(id))).cwd).toBe(TMP_DIR);
  });

  test("create rejects a relative execution cwd", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    expect(() => manager.create(sessionId(), TMP_DIR, { cwd: "relative/worktree", agentName: "engineer" }))
      .toThrow(expect.objectContaining({ name: "InvalidSessionCwdError" }));
  });

  test("create() does not expose legacy pending interactions", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store = manager.create(sessionId(), TMP_DIR, { agentName: "engineer" });

    expect(store.getState()).not.toHaveProperty("pendingInteractions");
  });

  test("legacy pending interaction mutators are not part of the store API", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store = manager.create(sessionId(), TMP_DIR, { agentName: "engineer" });

    expect(store.getState()).not.toHaveProperty("addPendingInteraction");
    expect(store.getState()).not.toHaveProperty("answerPendingInteraction");
    expect(store.getState()).not.toHaveProperty("expirePendingInteractions");
  });

  test("compression events persist compression state to disk", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });

    store.getState().append({ type: "compression.block_committed", block: compressionBlockSnapshot() });

    const persisted = await waitForSessionJson(
      canonicalSessionPath(id),
      (json) => JSON.stringify(json).includes("Persisted compression summary"),
    );

    const compression = persisted.compression as { blocksByRef?: Record<string, { tokenEstimate?: { savedTokens?: number } }> };
    expect(compression.blocksByRef?.b1?.tokenEstimate?.savedTokens).toBe(75);
  });

  test("dotted protocol stream events reduce while server-only events stay out of reducer state", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });
    const hitlRequest: HitlRecord = {
      hitlId: "hitl-1",
      owner: { projectSlug: "project-1", ownerType: "session", ownerId: id },
      sessionRootId: id,
      blockingKey: "ask-user:call-1",
      source: { type: "ask_user", sessionId: id, toolCallId: "call-1" },
      status: "pending",
      displayPayload: { title: "Need input", redacted: true },
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    };
    store.getState().append({ type: "hitl.request", request: hitlRequest });
    store.getState().append({
      type: "hitl.resolved",
      hitlId: "hitl-1",
      status: "resolved",
      response: { type: "question_answer", answers: ["yes"] },
    });
    const stateAfterDottedEvents = store.getState() as ReturnType<typeof store.getState> & Pick<SessionProjection, "hitlRequests">;
    expect(stateAfterDottedEvents.hitlRequests).toMatchObject([
      { hitlId: "hitl-1", status: "resolved", response: { type: "question_answer", answers: ["yes"] } },
    ]);

    store.getState().append({ type: "shutdown", reason: "test" });

    const stateAfterServerOnlyEvents = store.getState() as ReturnType<typeof store.getState> & Pick<SessionProjection, "hitlRequests">;
    expect(stateAfterServerOnlyEvents.hitlRequests).toEqual(stateAfterDottedEvents.hitlRequests);
  });

  test("get() returns undefined for unknown session", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    expect(manager.get(sessionId(), TMP_DIR)).toBeUndefined();
  });

  test("get() returns existing store after create()", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });
    expect(manager.get(id, TMP_DIR)).toBe(store);
  });

  test("has() returns correct boolean", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    expect(manager.has(id, TMP_DIR)).toBe(false);
    manager.create(id, TMP_DIR, { agentName: "engineer" });
    expect(manager.has(id, TMP_DIR)).toBe(true);
  });

  test("delete() removes store from registry", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    manager.create(id, TMP_DIR, { agentName: "engineer" });
    expect(manager.has(id, TMP_DIR)).toBe(true);
    const result = manager.delete(id, TMP_DIR);
    expect(result).toBe(true);
    expect(manager.has(id, TMP_DIR)).toBe(false);
  });

  test("delete() returns false for unknown session", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    expect(manager.delete(sessionId(), TMP_DIR)).toBe(false);
  });

  test("clearAll() removes all stores from registry", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const idA = sessionId();
    const idB = sessionId();
    manager.create(idA, TMP_DIR, { agentName: "engineer" });
    manager.create(idB, TMP_DIR, { agentName: "engineer" });
    manager.clearAll();
    expect(manager.has(idA, TMP_DIR)).toBe(false);
    expect(manager.has(idB, TMP_DIR)).toBe(false);
  });

  test("getOrLoad() returns existing store from registry without disk I/O", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const created = manager.create(id, TMP_DIR, { agentName: "engineer" });
    created.getState().title = "in-memory-title";

    const loaded = await manager.getOrLoad(id, TMP_DIR);
    expect(loaded).toBe(created);
    expect(loaded.getState().title).toBe("in-memory-title");
  });

  test("getOrLoad() loads from disk when not in registry", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();

    await sessionFileInternals.saveSessionTranscript(
      persistedSession(sessionId, {
        sessionId,
        createdAt: 1000,
        title: "disk-title",
      }),
      TMP_DIR,
    );

    const store = await manager.getOrLoad(sessionId, TMP_DIR);
    expect(store.getState().sessionId).toBe(sessionId);
    expect(store.getState().title).toBe("disk-title");
    expect(store.getState().cwd).toBe(TMP_DIR);
  });

  test("persists background child session completion link events", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const parentSessionId = sessionId();
    const childSessionId = sessionId();
    const store = manager.create(parentSessionId, TMP_DIR, { agentName: "engineer" });
    const link = {
      parentSessionId,
      parentToolCallId: "tool-call-1",
      toolName: "delegate",
      childSessionId,
      childAgentName: "explore",
      title: "Background child",
      description: "Run in the background",
      depth: 1,
      background: true,
      status: "completed" as const,
      createdAt: 100,
      startedAt: 110,
      endedAt: 210,
      durationMs: 100,
      summary: "Background work completed",
    };

    store.getState().append({ type: "tool-child-session-link", link });

    const raw = await waitForSessionJson(
      canonicalSessionPath(parentSessionId),
      (json) => Array.isArray(json.childSessionLinks) && json.childSessionLinks.length === 1,
    );
    expect(raw.childSessionLinks).toEqual([link]);

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(parentSessionId, TMP_DIR);
    expect(loaded.getState().childSessionLinks).toEqual([link]);
  });

  test("persists tool attempts and reconciles missing effectful results as unknown", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });

    store.getState().append({ type: "execution-start", executionId: "run-1" });
    store.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "file_write", input: { path: "a.ts" } });
    store.getState().append({
      type: "tool-attempt",
      toolCallId: "call-1",
      toolName: "file_write",
      attemptId: "attempt-1",
      timestamp: 123,
      destructive: true,
    });

    const filePath = canonicalSessionPath(id);
    const raw = await waitForSessionJson(filePath, (json) => JSON.stringify(json).includes("attempt-1"));
    expect(JSON.stringify(raw)).toContain("attempt-1");

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    const tool = loaded.getState().messages[0]?.parts[0];
    expect(tool).toMatchObject({
      type: "tool",
      state: "error",
      toolCallId: "call-1",
      errorMessage: "Tool execution result unknown: execution was interrupted",
      meta: { unknownResult: true },
    });
  });

  test("load reconciliation marks interrupted partial text visible but excluded from model context", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await sessionFileInternals.saveSessionTranscript(
      persistedSession(id, {
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "text",
                id: "text-1",
                text: "PARTIAL_LOAD_TEXT_SHOULD_NOT_PROJECT",
                createdAt: 1001,
              },
            ],
            createdAt: 1001,
            executionId: "run-1",
          },
        ],
        executions: [{ id: "run-1", startedAt: 1000, status: "running" }],
      }),
      TMP_DIR,
    );

    const loaded = await manager.getOrLoad(id, TMP_DIR);
    const text = loaded.getState().messages[0]?.parts[0];
    expect(text).toMatchObject({
      type: "text",
      text: "PARTIAL_LOAD_TEXT_SHOULD_NOT_PROJECT",
      meta: { interrupted: true, discardedFromContext: true },
    });
    expect(JSON.stringify(loaded.getState().toModelMessages())).toContain("previous assistant response was interrupted");
    expect(JSON.stringify(loaded.getState().toModelMessages())).not.toContain("PARTIAL_LOAD_TEXT_SHOULD_NOT_PROJECT");
    expect(loaded.getState().executions[0]).toMatchObject({ status: "interrupted" });
  });

  test("load reconciliation preserves waiting_for_human execution status", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await sessionFileInternals.saveSessionTranscript(
      persistedSession(id, {
        executions: [{ id: "run-1", startedAt: 1000, status: "waiting_for_human", endedAt: 2000, durationMs: 1000 }],
      }),
      TMP_DIR,
    );

    const loaded = await manager.getOrLoad(id, TMP_DIR);

    expect(loaded.getState().executions[0]).toMatchObject({
      id: "run-1",
      status: "waiting_for_human",
      endedAt: 2000,
      durationMs: 1000,
    });
  });

  test("persists completed tool results and does not downgrade them on restart", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });

    store.getState().append({ type: "execution-start", executionId: "run-1" });
    store.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "file_write", input: { path: "a.ts" } });
    store.getState().append({
      type: "tool-attempt",
      toolCallId: "call-1",
      toolName: "file_write",
      attemptId: "attempt-1",
      timestamp: 123,
      destructive: true,
    });
    store.getState().append({ type: "tool-result", toolCallId: "call-1", toolName: "file_write", output: "written", isError: false });

    const filePath = canonicalSessionPath(id);
    await waitForSessionJson(filePath, (json) => JSON.stringify(json).includes("written"));

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    const tool = loaded.getState().messages[0]?.parts[0];
    expect(tool).toMatchObject({
      type: "tool",
      state: "completed",
      toolCallId: "call-1",
      output: "written",
      attemptId: "attempt-1",
    });
    expect(JSON.stringify(tool)).not.toContain("unknownResult");
  });

  test("persists execution-error in session JSON file", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });
    const errorMsg = "Execution terminated due to terminal failure";

    store.getState().append({ type: "execution-start", executionId: "run-1" });
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "execution-error", step: 0, error: errorMsg });

    const filePath = canonicalSessionPath(id);
    const raw = await waitForSessionJson(filePath, (json) => JSON.stringify(json).includes(errorMsg));
    expect(JSON.stringify(raw)).toContain(errorMsg);
  });

  test("restarted SessionStoreManager reloads execution error in steps", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "engineer" });
    const errorMsg = "model crashed in step 0";

    store.getState().append({ type: "execution-start", executionId: "run-1" });
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "execution-error", step: 0, error: errorMsg });

    const filePath = canonicalSessionPath(id);
    await waitForSessionJson(filePath, (json) => JSON.stringify(json).includes(errorMsg));

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    const stepWithError = loaded.getState().steps.find((s) => s.error !== undefined);
    expect(stepWithError).toBeDefined();
    expect(stepWithError!.error).toBe(errorMsg);
  });

  test("recovery-notice part with statusCode reloads correctly", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await sessionFileInternals.saveSessionTranscript(
      persistedSession(id, {
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "recovery-notice",
                id: "recovery:session:step-1",
                status: "failed",
                message: "Model result finalization failed: model not found",
                attempt: 0,
                errorKind: "config",
                statusCode: 422,
                createdAt: 1001,
                completedAt: 1002,
              },
            ],
            createdAt: 1001,
            completedAt: 1002,
          },
        ],
      }),
      TMP_DIR,
    );

    const loaded = await manager.getOrLoad(id, TMP_DIR);

    expect(loaded.getState().messages[0]?.parts[0]).toMatchObject({
      type: "recovery-notice",
      status: "failed",
      statusCode: 422,
    });
  });

  test("getSessionFile() finds a child session through lazy descendant scan", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const childSessionId = sessionId();

    await sessionFileInternals.saveSessionTranscript(
      persistedSession(childSessionId, {
        agentName: "explore",
        title: "child-title",
        rootSessionId,
        parentSessionId: rootSessionId,
      }),
      TMP_DIR,
    );

    const file = await manager.getSessionFile(TMP_DIR, childSessionId);

    expect(file.sessionId).toBe(childSessionId);
    expect(file.rootSessionId).toBe(rootSessionId);
    expect(file.title).toBe("child-title");
  });

  test("create() persists child sessions in their own owner directory without legacy files", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    manager.create(rootSessionId, TMP_DIR, { agentName: "engineer" });

    const childStore = manager.create(childSessionId, TMP_DIR, {
      rootSessionId,
      parentSessionId: rootSessionId,
      title: "child-title", agentName: "engineer"
    });
    await manager.getSessionFile(TMP_DIR, childSessionId);

    expect(childStore.getState()).toMatchObject({
      sessionId: childSessionId,
      rootSessionId,
      parentSessionId: rootSessionId,
      title: "child-title",
    });
    expect(await Bun.file(join(TMP_DIR, ".archcode", "sessions", `${childSessionId}.json`)).exists()).toBe(false);
    expect(await Bun.file(join(TMP_DIR, ".archcode", "sessions", rootSessionId, `${childSessionId}.json`)).exists()).toBe(false);
    const childPath = canonicalSessionPath(childSessionId);
    await waitForFile(childPath);
    const childFile = JSON.parse(await Bun.file(childPath).text()) as Record<string, unknown>;
    expect(childFile).toMatchObject({ sessionId: childSessionId, rootSessionId, parentSessionId: rootSessionId });
  });

  test("getSessionFile() reuses the lazy index after the first scan", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    const originalScanAllSessionSummaries = sessionFileInternals.scanAllSessionSummaries;
    let scanCount = 0;

    await sessionFileInternals.saveSessionTranscript(
      persistedSession(childSessionId, {
        agentName: "explore",
        title: "child-title",
        rootSessionId,
        parentSessionId: rootSessionId,
      }),
      TMP_DIR,
    );

    sessionFileInternals.scanAllSessionSummaries = async (...args) => {
      scanCount += 1;
      return await originalScanAllSessionSummaries(...args);
    };

    try {
      await manager.getSessionFile(TMP_DIR, childSessionId);
      await manager.getSessionFile(TMP_DIR, childSessionId);
    } finally {
      sessionFileInternals.scanAllSessionSummaries = originalScanAllSessionSummaries;
    }

    expect(scanCount).toBe(1);
  });

  test("getOrLoad() does NOT overwrite an existing store (Bug 1 regression)", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();

    // Create store with in-memory state
    const created = manager.create(sessionId, TMP_DIR, { agentName: "engineer" });
    created.setState({ title: "in-memory-title" });

    // Also save a file with different data
    await sessionFileInternals.saveSessionTranscript(
      persistedSession(sessionId, {
        title: "disk-title",
      }),
      TMP_DIR,
    );

    // getOrLoad should return the existing in-memory store, not overwrite
    const loaded = await manager.getOrLoad(sessionId, TMP_DIR);
    expect(loaded).toBe(created);
    expect(loaded.getState().title).toBe("in-memory-title");
  });

  test("getOrLoad() throws on missing file", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    await expect(manager.getOrLoad(sessionId(), TMP_DIR)).rejects.toThrow();
  });

  test("getOrLoad() throws on invalid JSON", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    await writeRawSessionFile(sessionId, "not json");
    await expect(manager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("getOrLoad() deduplicates concurrent loads for the same session", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();

    await sessionFileInternals.saveSessionTranscript(
      persistedSession(sessionId, {
        title: "disk-title",
      }),
      TMP_DIR,
    );

    const [store1, store2] = await Promise.all([
      manager.getOrLoad(sessionId, TMP_DIR),
      manager.getOrLoad(sessionId, TMP_DIR),
    ]);

    expect(store1).toBe(store2);
  });

  test("getOrLoad() does not overwrite store created during I/O window", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();

    await sessionFileInternals.saveSessionTranscript(
      persistedSession(sessionId, {
        title: "disk-title",
      }),
      TMP_DIR,
    );

    // Simulate a concurrent create() that happens while getOrLoad is reading from disk.
    // Start getOrLoad, but also create a store with live state before getOrLoad resolves.
    // The getOrLoad should return the live store, not overwrite it with disk data.
    const loadedPromise = manager.getOrLoad(sessionId, TMP_DIR);

    // Create a store with live state (simulating an agent starting up concurrently)
    const liveStore = manager.create(sessionId, TMP_DIR, { agentName: "engineer" });
    liveStore.setState({ title: "live-title" });

    const loaded = await loadedPromise;
    // If getOrLoad saw the live store after I/O re-check, it returns it without overwriting.
    // If it missed it, it would have called create() which returns the existing live store
    // anyway (idempotent), then setState would overwrite with disk data.
    // Both paths should return the live store since create() is idempotent and the
    // re-check in #loadFromDisk prevents overwriting.
    expect(loaded).toBe(liveStore);
    expect(loaded.getState().title).toBe("live-title");
  });

  test("buildSessionTree() returns empty tree for root without children", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root" });

    const tree = await manager.buildSessionTree(TMP_DIR, rootSessionId);

    expect(tree.diagnostics).toEqual([]);
    expect(tree.root.session.sessionId).toBe(rootSessionId);
    expect(tree.root.session.title).toBe("root");
    expect(tree.root.session.agentName).toBe("engineer");
    expect(tree.root.children).toEqual([]);
  });

  test("listSessionFamilyBlockedHitlIds reads and deduplicates durable sibling blockers", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const firstChildId = sessionId();
    const secondChildId = sessionId();
    const firstHitlId = crypto.randomUUID();
    const secondHitlId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootSessionId, title: "root", blockedByHitlIds: [secondHitlId] });
    await writeSessionFile({
      sessionId: firstChildId,
      rootSessionId,
      parentSessionId: rootSessionId,
      blockedByHitlIds: [firstHitlId, secondHitlId],
    });
    await writeSessionFile({
      sessionId: secondChildId,
      rootSessionId,
      parentSessionId: rootSessionId,
      blockedByHitlIds: [firstHitlId],
    });

    expect(await manager.listSessionFamilyBlockedHitlIds(TMP_DIR, rootSessionId))
      .toEqual([firstHitlId, secondHitlId].sort());
  });

  test("buildSessionTree() nests root, child, and grandchild", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    const grandchildSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root", createdAt: 1 });
    await writeSessionFile({ sessionId: childSessionId, rootSessionId, parentSessionId: rootSessionId, title: "child", createdAt: 2 });
    await writeSessionFile({ sessionId: grandchildSessionId, rootSessionId, parentSessionId: childSessionId, title: "grandchild", createdAt: 3 });

    const tree = await manager.buildSessionTree(TMP_DIR, rootSessionId);

    expect(tree.diagnostics).toEqual([]);
    expect(tree.root.session.sessionId).toBe(rootSessionId);
    expect(tree.root.children).toHaveLength(1);
    expect(tree.root.children[0].session.sessionId).toBe(childSessionId);
    expect(tree.root.children[0].session.agentName).toBe("explore");
    expect(tree.root.children[0].children).toHaveLength(1);
    expect(tree.root.children[0].children[0].session.sessionId).toBe(grandchildSessionId);
    expect("childSessionIds" in tree.root.session).toBe(false);
    expect("subAgentDescriptions" in tree.root.session).toBe(false);
    expect("childSessionIds" in tree.root.children[0].session).toBe(false);
    expect("subAgentDescriptions" in tree.root.children[0].session).toBe(false);
  });

  test("buildSessionTree() fails instead of skipping invalid descendants", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const validChildId = sessionId();
    const missingParentId = sessionId();
    const absentParentId = sessionId();
    const rootMismatchId = sessionId();
    const otherRootId = sessionId();
    const mismatchFileId = sessionId();
    const mismatchJsonId = sessionId();
    const invalidJsonId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root" });
    await writeSessionFile({ sessionId: validChildId, rootSessionId, parentSessionId: rootSessionId, title: "valid" });
    await writeSessionFile({ sessionId: missingParentId, rootSessionId, parentSessionId: absentParentId, title: "orphan" });

    await writeRawSessionFile(rootMismatchId, JSON.stringify(persistedSession(rootMismatchId, {
      agentName: "explore",
      title: "bad-root",
      rootSessionId: otherRootId,
      parentSessionId: rootSessionId,
    })));
    await writeRawSessionFile(mismatchFileId, JSON.stringify(persistedSession(mismatchJsonId, {
      agentName: "explore",
      title: "mismatch",
      rootSessionId,
      parentSessionId: rootSessionId,
    })));
    await writeRawSessionFile(invalidJsonId, "not json");

    await expect(manager.buildSessionTree(TMP_DIR, rootSessionId)).rejects.toBeInstanceOf(SessionTreeIntegrityError);
  });

  test("buildSessionTree() fails on an invalid descendant schema", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const fileSessionId = sessionId();
    const jsonSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root" });
    await writeRawSessionFile(fileSessionId, JSON.stringify(persistedSession(jsonSessionId, {
      agentName: "explore",
      title: "invalid-node",
      todos: [{ id: "a", content: "first", status: "in_progress" }, { id: "b", content: "second", status: "in_progress" }],
      rootSessionId,
      parentSessionId: rootSessionId,
    })));

    await expect(manager.buildSessionTree(TMP_DIR, rootSessionId)).rejects.toMatchObject({
      name: "SessionTreeIntegrityError",
      reason: "invalid_schema",
    });
  });

  test("buildSessionTree() fails on duplicate session IDs", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root" });
    const duplicateDirSessionId = sessionId();
    await writeRawSessionFile(duplicateDirSessionId, JSON.stringify(persistedSession(rootSessionId, {
      agentName: "explore",
      title: "duplicate-root",
      rootSessionId,
      parentSessionId: rootSessionId,
    })));

    await expect(manager.buildSessionTree(TMP_DIR, rootSessionId)).rejects.toMatchObject({
      name: "SessionTreeIntegrityError",
      reason: "duplicate_session",
    });
  });

  test("buildSessionTree() fails on parent cycles", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const firstId = sessionId();
    const secondId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root" });
    await writeSessionFile({ sessionId: firstId, rootSessionId, parentSessionId: secondId, title: "first" });
    await writeSessionFile({ sessionId: secondId, rootSessionId, parentSessionId: firstId, title: "second" });

    await expect(manager.buildSessionTree(TMP_DIR, rootSessionId)).rejects.toMatchObject({
      name: "SessionTreeIntegrityError",
      reason: "cycle",
    });
  });

  test("buildSessionTree() rejects a descendant with the removed schemaVersion field", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root" });
    await writeRawSessionFile(childSessionId, JSON.stringify({ ...persistedSession(childSessionId, {
      rootSessionId,
      parentSessionId: rootSessionId,
    }), schemaVersion: 1 }));

    await expect(manager.buildSessionTree(TMP_DIR, rootSessionId)).rejects.toMatchObject({
      name: "SessionTreeIntegrityError",
      reason: "invalid_schema",
    });
  });

  test("buildSessionTree() ignores a separate valid Session family", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const otherRootSessionId = sessionId();
    const otherChildSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root" });
    await writeSessionFile({ sessionId: otherRootSessionId, title: "other-root" });
    await writeSessionFile({
      sessionId: otherChildSessionId,
      rootSessionId: otherRootSessionId,
      parentSessionId: otherRootSessionId,
      title: "other-child",
    });

    const tree = await manager.buildSessionTree(TMP_DIR, rootSessionId);

    expect(tree.root.children).toEqual([]);
    expect(tree.diagnostics).toEqual([]);
  });

  test("buildSessionTree() throws NotRootSessionError when called on a child", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const childSessionId = sessionId();
    const parentSessionId = sessionId();
    await writeSessionFile({ sessionId: childSessionId, rootSessionId: childSessionId, parentSessionId, title: "child-as-root-file" });

    await expect(manager.buildSessionTree(TMP_DIR, childSessionId)).rejects.toThrow(NotRootSessionError);
    try {
      await manager.buildSessionTree(TMP_DIR, childSessionId);
    } catch (error) {
      expect(error).toBeInstanceOf(NotRootSessionError);
      expect((error as NotRootSessionError).name).toBe("NotRootSessionError");
      expect((error as NotRootSessionError).sessionId).toBe(childSessionId);
      expect((error as NotRootSessionError).parentSessionId).toBe(parentSessionId);
    }
  });

  test("restart regression: lazy child lookup, root-only list, and tree contracts use persisted identity", async () => {
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    const grandchildSessionId = sessionId();
    const siblingSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root", createdAt: 1 });
    await writeSessionFile({ sessionId: childSessionId, rootSessionId, parentSessionId: rootSessionId, title: "child", createdAt: 2 });
    await writeSessionFile({ sessionId: grandchildSessionId, rootSessionId, parentSessionId: childSessionId, title: "grandchild", createdAt: 3 });
    await writeSessionFile({ sessionId: siblingSessionId, rootSessionId, parentSessionId: rootSessionId, title: "sibling", createdAt: 4 });

    // Recreate the manager so the child -> root index must be rebuilt from disk.
    const restartedManager = new SessionStoreManager({ logger: silentLogger });
    const childFile = await restartedManager.getSessionFile(TMP_DIR, childSessionId);
    const childStore = await restartedManager.getOrLoad(childSessionId, TMP_DIR);
    const summaries = await restartedManager.listSessionSummaries(TMP_DIR);
    const tree = await restartedManager.buildSessionTree(TMP_DIR, rootSessionId);

    expect(childFile).toMatchObject({
      sessionId: childSessionId,
      rootSessionId,
      parentSessionId: rootSessionId,
      title: "child",
    });
    expect(childStore.getState()).toMatchObject({
      sessionId: childSessionId,
      rootSessionId,
      parentSessionId: rootSessionId,
      title: "child",
    });
    expect(summaries.map((session) => session.sessionId)).toEqual([rootSessionId]);
    expect(summaries[0]).toMatchObject({
      sessionId: rootSessionId,
      rootSessionId,
    });
    expect(summaries[0]).not.toHaveProperty("parentSessionId");
    expect(tree.diagnostics).toEqual([]);
    expect(tree.root.session).toMatchObject({ sessionId: rootSessionId, rootSessionId });
    expect(tree.root.children.map((node) => node.session.sessionId)).toEqual([childSessionId, siblingSessionId]);
    expect(tree.root.children[0].session).toMatchObject({
      sessionId: childSessionId,
      rootSessionId,
      parentSessionId: rootSessionId,
    });
    expect(tree.root.children[0].children[0].session).toMatchObject({
      sessionId: grandchildSessionId,
      rootSessionId,
      parentSessionId: childSessionId,
    });
    const sessionsDirEntries = await readdir(join(TMP_DIR, ".archcode", "sessions"), { withFileTypes: true });
    expect(sessionsDirEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)).toEqual([]);
    expect(sessionsDirEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()).toEqual([
      childSessionId,
      grandchildSessionId,
      rootSessionId,
      siblingSessionId,
    ].sort());

    const childAsRootManager = new SessionStoreManager({ logger: silentLogger });
    await Bun.write(join(TMP_DIR, ".archcode", "sessions", `${childSessionId}.json`), JSON.stringify({
      ...childFile,
      rootSessionId: childSessionId,
      parentSessionId: rootSessionId,
    }));
    await expect(childAsRootManager.getSessionFile(TMP_DIR, childSessionId)).resolves.toMatchObject({ rootSessionId });
    await expect(childAsRootManager.buildSessionTree(TMP_DIR, childSessionId)).rejects.toThrow(NotRootSessionError);
  });
});
