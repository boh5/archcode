import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_EVENTS,
  createEmptySessionStats,
  type CompressionBlockSnapshot,
  type DelegationRequest,
  type FinalizedToolResult,
  type SessionExecutionRecord,
  type SessionMessage,
  type ToolChildSessionLink,
  type ToolPart,
} from "@archcode/protocol";
import { COMPRESSION_SUMMARY_SECTION_NAMES, createEmptyCompressionState } from "../compression";
import { SessionStoreManager } from "./session-store-manager";
import type { SessionToolBatch } from "./types";
import { NotRootSessionError, SessionInitialPersistenceError, SessionTreeIntegrityError } from "./errors";
import { SessionFileIdentityConflictError } from "./session-store-manager";
import { sessionFileInternals } from "./helpers";
import { silentLogger } from "../logger";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "session-store-manager", crypto.randomUUID());
const TEST_REQUESTED_MODEL_SELECTION = { mode: "profile_default" as const, selection: { model: "test:model" } };
const TEST_BINDING = {
  selection: { model: "test:model" }, providerId: "test", modelId: "model",
  providerDisplayName: "Test", modelDisplayName: "Model",
  resolution: "profile_default" as const, modelRuntimeRevision: "runtime-1",
};
const executionStart = (executionId: string) => ({
  type: "execution-start" as const,
  executionId,
  binding: TEST_BINDING,
  origin: "user_message" as const,
  maxSteps: 50,
});

function executionEnd(
  store: ReturnType<SessionStoreManager["create"]>,
  terminalStatus: "completed" | "aborted",
) {
  const state = store.getState();
  const execution = state.executions.find((candidate) => candidate.id === state.currentExecutionId);
  if (execution === undefined || execution.status !== "running") throw new Error("Expected running Execution");
  const run = execution.runs.at(-1)!;
  const endedAt = Math.max(Date.now(), run.startedAt);
  return {
    type: "execution-end" as const,
    executionId: execution.id,
    terminalStatus,
    endedAt,
    runEndedAt: endedAt,
    runUsageDelta: createEmptySessionStats().usage,
    runSettlement: { key: `run:${state.sessionId}:${execution.id}:${run.ordinal}`, goalInstanceId: null },
    terminalSettlement: { key: `terminal:${state.sessionId}:${execution.id}`, goalInstanceId: null },
  };
}

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
      summary: {
        sections: Object.fromEntries(
          COMPRESSION_SUMMARY_SECTION_NAMES.map((section) => [
            section,
            section === "Current Objective" ? "Persisted compression summary" : "None",
          ]),
        ) as CompressionBlockSnapshot["summary"]["sections"],
      },
      childBlockRefs: [],
      protectedRefs: ["m0002"],
      tokenEstimate: { originalTokens: 100, summaryTokens: 25, savedTokens: 75, estimatedAt: 1234 },
      createdAt: 1000,
      updatedAt: 1001,
    };
  }

  function finalizedResult(preview: string, isError = false): FinalizedToolResult {
    const bytes = new TextEncoder().encode(preview).byteLength;
    return {
      isError,
      output: {
        preview,
        completeness: "complete",
        observed: { bytes, lines: 1 },
        canonical: { bytes, lines: 1 },
        stored: { bytes, lines: 1 },
        omitted: { bytes: 0, lines: 0 },
        recovery: { kind: "none" },
      },
    };
  }

  type PersistedSessionState = Parameters<typeof sessionFileInternals.saveSessionTranscript>[0];

  function runningExecution(id: string, startedAt = 1000): SessionExecutionRecord {
    return {
      id,
      startedAt,
      status: "running",
      origin: "user_message",
      maxSteps: 50,
      durationMs: 0,
      runs: [{ ordinal: 0, startedAt, binding: TEST_BINDING }],
    };
  }

  function interruptedExecution(
    sessionId: string,
    id: string,
    startedAt = 1000,
    endedAt = 1300,
  ): SessionExecutionRecord {
    return {
      id,
      startedAt,
      status: "interrupted",
      origin: "tool_call",
      maxSteps: 50,
      endedAt,
      durationMs: endedAt - startedAt,
      runs: [{
        ordinal: 0,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        binding: TEST_BINDING,
        usageDelta: createEmptySessionStats().usage,
        settlement: { key: `run:${sessionId}:${id}:0`, goalInstanceId: null },
      }],
      terminalSettlement: { key: `terminal:${sessionId}:${id}`, goalInstanceId: null },
    };
  }

  function persistedSession(
    id: string,
    overrides: Partial<PersistedSessionState> = {},
  ): PersistedSessionState {
    const delegationRequest: DelegationRequest = {
      agent_type: "explore",
      profile: "fast",
      title: "Test child",
      objective: "Exercise persisted child identity",
      skills: [],
      background: false,
    };
    return {
      sessionId: id,
      createdAt: 1000,
      updatedAt: 1000,
      cwd: TMP_DIR,
      agentName: overrides.parentSessionId === undefined ? "lead" : "explore",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title: null,
      messages: [],
      pendingMessages: [],
      inputRequestReceipts: [],
      steps: [],
      stats: createEmptySessionStats(),
      executions: [],
      promptTraces: [],
      compression: createEmptyCompressionState(),
      todos: [],
      reminders: [],
      childSessionLinks: [],
      toolBatches: [],
      rootSessionId: id,
      nextEventId: 0,
      ...(overrides.parentSessionId === undefined ? {} : {
        delegationRequest: {
          ...delegationRequest,
          skills: overrides.activeSkillNames ?? [],
        },
      }),
      ...overrides,
    };
  }

  function persistedCheckpointSession(input: {
    id: string;
    isError: boolean;
    projection: "running" | "interrupted" | "settled";
    settledAt?: number;
    projectedSettledAt?: number;
    projectedResult?: FinalizedToolResult;
  }): PersistedSessionState {
    const settledAt = input.settledAt ?? 1400;
    const result = finalizedResult(input.isError ? "failed checkpoint" : "completed checkpoint", input.isError);
    const basePart = {
      type: "tool" as const,
      id: "tool-part-checkpoint",
      toolCallId: "call-checkpoint",
      toolName: "read_tool",
      input: { value: "checkpoint" },
      createdAt: 1100,
      startedAt: 1200,
    };
    const part: ToolPart = input.projection === "running"
      ? {
          ...basePart,
          state: "running",
          liveOutput: {
            preview: "TRANSIENT_LIVE_CHECKPOINT_OUTPUT",
            omittedBytes: 7,
            liveLimitReached: false,
          },
        }
      : input.projection === "interrupted"
      ? {
          ...basePart,
          state: "interrupted",
          endedAt: 1300,
        }
      : {
          ...basePart,
          state: input.isError ? "error" : "completed",
          endedAt: input.projectedSettledAt ?? settledAt,
          result: input.projectedResult ?? result,
        };
    const message: SessionMessage = {
      id: "assistant-checkpoint",
      role: "assistant",
      parts: [part],
      createdAt: 1000,
      completedAt: 1300,
      executionId: "execution-checkpoint",
      runOrdinal: 0,
    };
    const batch: SessionToolBatch = {
      batchId: "batch-checkpoint",
      executionId: "execution-checkpoint",
      runOrdinal: 0,
      assistantMessageId: message.id,
      step: 0,
      agentName: "lead",
      allowedTools: ["read_tool"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: ["call-checkpoint"] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId: "call-checkpoint",
        toolName: "read_tool",
        input: { value: "checkpoint" },
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        state: input.isError ? "failed" : "completed",
        attempt: 1,
        checkpointAt: settledAt,
        result,
        settledAt,
      }],
      createdAt: new Date(1000).toISOString(),
      updatedAt: new Date(settledAt).toISOString(),
    };
    const emptyStats = createEmptySessionStats();
    const projectionAlreadySettled = input.projection === "settled";
    return persistedSession(input.id, {
      messages: [message],
      stats: {
        ...emptyStats,
        tools: {
          calls: 1,
          completed: projectionAlreadySettled && !input.isError ? 1 : 0,
          failed: projectionAlreadySettled && input.isError ? 1 : 0,
        },
      },
      steps: [{
        id: "step-checkpoint",
        executionId: "execution-checkpoint",
        runOrdinal: 0,
        step: 0,
        startedAt: 1000,
        completedAt: 1100,
        finishReason: "tool-calls",
      }],
      executions: [interruptedExecution(input.id, "execution-checkpoint")],
      toolBatches: [batch],
    });
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
      const createdPromise = manager.createSessionFile(TMP_DIR, { agentName: "lead" }).finally(() => { settled = true; });
      await saveStarted;
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseSave();
      const created = await createdPromise;
      expect(await Bun.file(join(TMP_DIR, ".archcode", "runtime", "sessions", created.sessionId, "session.json")).exists()).toBe(true);
    } finally {
      releaseSave();
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("publishes durable mutation events only after persistence and then releases later events in order", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await manager.createSessionFile(TMP_DIR, { agentName: "lead" }, id);
    const store = manager.get(id, TMP_DIR)!;
    const received: string[] = [];
    manager.subscribeToSessionEvents(({ envelope }) => received.push(envelope.payload.type));

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
      const mutation = manager.commitDurableSessionMutation(id, TMP_DIR, () => ({
        result: undefined,
        events: [{ type: "system-notice", message: "accepted" }],
      }));
      await saveStarted;
      store.getState().append({ type: "text-delta", text: "later" });

      expect(received).toEqual([]);
      expect(store.getState().publishableNextEventId).toBe(0);

      releaseSave();
      await mutation;
      expect(received).toEqual(["system-notice", "text-delta"]);
      expect(store.getState().publishableNextEventId).toBe(2);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
      releaseSave();
    }
  });

  test("retains every unpublished event beyond the ring cap and trims immediately after the persistence barrier", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await manager.createSessionFile(TMP_DIR, { agentName: "lead" }, id);
    const store = manager.get(id, TMP_DIR)!;
    const receivedIds: number[] = [];
    manager.subscribeToSessionEvents(({ envelope }) => receivedIds.push(envelope.id));

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
      const mutation = manager.commitDurableSessionMutation(id, TMP_DIR, () => ({
        result: undefined,
        events: [{ type: "system-notice", message: "durable barrier" }],
      }));
      await saveStarted;

      for (let index = 0; index < MAX_EVENTS; index += 1) {
        store.getState().append({
          type: "reminder-consumed",
          reminderIds: [`missing-${index}`],
        });
      }

      const withheld = store.getState();
      expect(withheld.events).toHaveLength(MAX_EVENTS + 1);
      expect(withheld.eventOffset).toBe(0);
      expect(withheld.publishableNextEventId).toBe(0);
      expect(withheld.events[0]?.id).toBe(0);
      expect(withheld.events.at(-1)?.id).toBe(MAX_EVENTS);
      expect(receivedIds).toEqual([]);

      releaseSave();
      await mutation;

      const published = store.getState();
      expect(receivedIds).toHaveLength(MAX_EVENTS + 1);
      expect(receivedIds[0]).toBe(0);
      expect(receivedIds.at(-1)).toBe(MAX_EVENTS);
      expect(published.publishableNextEventId).toBe(MAX_EVENTS + 1);
      expect(published.events).toHaveLength(MAX_EVENTS);
      expect(published.eventOffset).toBe(1);
      expect(published.events[0]?.id).toBe(1);
      expect(published.events.at(-1)?.id).toBe(MAX_EVENTS);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
      releaseSave();
    }
  });

  test("a later multi-event transaction remains entirely behind its own persistence barrier", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await manager.createSessionFile(TMP_DIR, { agentName: "lead" }, id);
    const received: string[] = [];
    manager.subscribeToSessionEvents(({ envelope }) => received.push(envelope.payload.type));

    const originalSave = sessionFileInternals.saveSessionTranscript;
    const releases: Array<() => void> = [];
    const starts: Array<() => void> = [];
    const started = [
      new Promise<void>((resolve) => starts.push(resolve)),
      new Promise<void>((resolve) => starts.push(resolve)),
    ];
    let saveIndex = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      const index = saveIndex++;
      starts[index]?.();
      await new Promise<void>((resolve) => releases[index] = resolve);
      await originalSave(state, workspaceRoot);
    };

    try {
      const first = manager.commitDurableSessionMutation(id, TMP_DIR, () => ({
        result: undefined,
        events: [{ type: "system-notice", message: "first" }],
      }));
      await started[0];
      const second = manager.commitDurableSessionMutation(id, TMP_DIR, () => ({
        result: undefined,
        events: [
          executionStart("execution-2"),
          { type: "system-notice", message: "second" },
        ],
      }));
      await Promise.resolve();

      releases[0]!();
      await first;
      await started[1];
      expect(received).toEqual(["system-notice"]);
      expect(manager.get(id, TMP_DIR)!.getState().publishableNextEventId).toBe(1);

      releases[1]!();
      await second;
      expect(received).toEqual(["system-notice", "execution-start", "system-notice"]);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
      for (const release of releases) release?.();
    }
  });

  test("durable no-ops preserve state identity and do not enqueue persistence", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await manager.createSessionFile(TMP_DIR, { agentName: "lead" }, id);
    const store = manager.get(id, TMP_DIR)!;
    const originalState = store.getState();
    const originalUpdatedAt = originalState.updatedAt;
    let subscriberCalls = 0;
    const unsubscribe = store.subscribe(() => {
      subscriberCalls += 1;
    });

    const originalSave = sessionFileInternals.saveSessionTranscript;
    let saveCount = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      saveCount += 1;
      await originalSave(state, workspaceRoot);
    };

    try {
      expect(await manager.commitDurableSessionMutation(id, TMP_DIR, () => ({ result: "replay" })))
        .toBe("replay");
      await manager.commitDurableSessionMutation(id, TMP_DIR, () => ({
        result: undefined,
        patch: {},
      }));
      await manager.commitDurableSessionMutation(id, TMP_DIR, (state) => ({
        result: undefined,
        patch: {
          title: state.title,
          queueDispatchBarrierAt: state.queueDispatchBarrierAt,
        },
      }));
      store.getState().setTitle(null);
      store.getState().setParentSessionId(undefined);
      expect(await manager.updateToolBatches(id, TMP_DIR, () => originalState.toolBatches))
        .toBe(originalState.toolBatches);
      await manager.flushSession(id, TMP_DIR);

      expect(store.getState()).toBe(originalState);
      expect(store.getState().updatedAt).toBe(originalUpdatedAt);
      expect(subscriberCalls).toBe(0);
      expect(saveCount).toBe(0);
    } finally {
      unsubscribe();
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("a result-only replay awaits the persistence barrier it observed", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await manager.createSessionFile(TMP_DIR, { agentName: "lead" }, id);

    const originalSave = sessionFileInternals.saveSessionTranscript;
    let releaseSave!: () => void;
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    let saveCount = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      saveCount += 1;
      markSaveStarted();
      await saveReleased;
      await originalSave(state, workspaceRoot);
    };

    try {
      const first = manager.commitDurableSessionMutation(id, TMP_DIR, () => ({
        result: "first",
        patch: { title: "durable" },
      }));
      await saveStarted;
      let replaySettled = false;
      const replay = manager.commitDurableSessionMutation(id, TMP_DIR, () => ({
        result: "first",
      })).finally(() => {
        replaySettled = true;
      });
      await Promise.resolve();

      expect(replaySettled).toBe(false);
      releaseSave();
      expect(await Promise.all([first, replay])).toEqual(["first", "first"]);
      expect(saveCount).toBe(1);
    } finally {
      releaseSave();
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("a result-only replay propagates failure from its observed persistence barrier", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await manager.createSessionFile(TMP_DIR, { agentName: "lead" }, id);

    const originalSave = sessionFileInternals.saveSessionTranscript;
    const failure = new Error("simulated durable commit failure");
    let releaseSave!: () => void;
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    sessionFileInternals.saveSessionTranscript = async () => {
      markSaveStarted();
      await saveReleased;
      throw failure;
    };

    try {
      const first = manager.commitDurableSessionMutation(id, TMP_DIR, () => ({
        result: "first",
        patch: { title: "not-durable" },
      }));
      await saveStarted;
      const replay = manager.commitDurableSessionMutation(id, TMP_DIR, () => ({
        result: "first",
      }));
      releaseSave();

      const results = await Promise.allSettled([first, replay]);
      expect(results).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
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
        await manager.createSessionFile(TMP_DIR, { agentName: "lead" });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(SessionInitialPersistenceError);
      const persistenceError = captured as SessionInitialPersistenceError;
      expect(persistenceError.cause).toBe(failure);
      expect(manager.has(persistenceError.sessionId, TMP_DIR)).toBe(false);
      expect(await Bun.file(join(TMP_DIR, ".archcode", "runtime", "sessions", persistenceError.sessionId, "session.json")).exists()).toBe(false);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("ensureSessionFile creates a caller-selected durable Session identity", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const created = await manager.ensureSessionFile(TMP_DIR, id, {
      agentName: "lead",
      rootSessionId: id,
      cwd: TMP_DIR,
    });

    expect(created).toMatchObject({
      sessionId: id,
      rootSessionId: id,
      agentName: "lead",
      cwd: TMP_DIR,
    });
    expect((await manager.getSessionFile(TMP_DIR, id)).sessionId).toBe(id);
  });

  test("returns durable fields and live reducer ownership from one Session snapshot", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });
    store.getState().append(executionStart("execution-1"));
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "Inspecting." });
    store.getState().append({ type: "text-end" });
    const currentAssistantMessageId = store.getState().currentAssistantMessageId;

    const snapshot = await manager.getSessionReadSnapshot(TMP_DIR, id);

    expect(snapshot.liveState).toEqual({
      executionCount: 1,
      isRunning: true,
      isStreamingModel: true,
      currentExecutionId: "execution-1",
      currentAssistantMessageId,
    });
    expect(snapshot.file.messages).toContainEqual(expect.objectContaining({
      id: currentAssistantMessageId,
      executionId: "execution-1",
      parts: [expect.objectContaining({
        type: "text",
        text: "Inspecting.",
        completedAt: expect.any(Number),
      })],
    }));
  });

  test("snapshot waits through a newly queued persistence revision and returns only its durable state", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await manager.createSessionFile(TMP_DIR, { agentName: "lead" }, id);
    const store = manager.get(id, TMP_DIR)!;

    const originalSave = sessionFileInternals.saveSessionTranscript;
    let firstStarted!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const secondSaveStarted = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let releaseSecond!: () => void;
    const secondSaveReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const savedTitles: Array<string | null> = [];
    let saveIndex = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      const index = saveIndex++;
      savedTitles.push(state.title);
      if (index === 0) {
        firstStarted();
        await originalSave(state, workspaceRoot);
        store.getState().setTitle("second durable title");
        return;
      }
      secondStarted();
      await secondSaveReleased;
      await originalSave(state, workspaceRoot);
    };

    try {
      store.getState().setTitle("first durable title");
      let snapshotSettled = false;
      const snapshotPromise = manager.getSessionReadSnapshot(TMP_DIR, id).finally(() => {
        snapshotSettled = true;
      });

      await firstSaveStarted;
      await secondSaveStarted;
      await Promise.resolve();
      expect(snapshotSettled).toBe(false);

      releaseSecond();
      const snapshot = await snapshotPromise;
      expect(snapshot.file.title).toBe("second durable title");
      expect(savedTitles).toEqual(["first durable title", "second durable title"]);
      expect((await readSessionJson(canonicalSessionPath(id))).title).toBe("second durable title");
    } finally {
      releaseSecond();
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("snapshot propagates failure from the persistence revision it must observe", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    await manager.createSessionFile(TMP_DIR, { agentName: "lead" }, id);
    const store = manager.get(id, TMP_DIR)!;
    const originalSave = sessionFileInternals.saveSessionTranscript;
    const failure = new Error("simulated snapshot revision failure");
    sessionFileInternals.saveSessionTranscript = async () => {
      throw failure;
    };

    try {
      store.getState().setTitle("must remain non-authoritative");
      await expect(manager.getSessionReadSnapshot(TMP_DIR, id)).rejects.toBe(failure);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("ensureSessionFile verifies an existing stable identity without overwriting it", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const options = {
      agentName: "lead" as const,
      rootSessionId: id,
      cwd: TMP_DIR,
    };
    const first = await manager.ensureSessionFile(TMP_DIR, id, options);

    await expect(manager.ensureSessionFile(TMP_DIR, id, options)).resolves.toEqual(first);
    await expect(manager.ensureSessionFile(TMP_DIR, id, {
      ...options,
      cwd: join(TMP_DIR, "other"),
    })).rejects.toBeInstanceOf(SessionFileIdentityConflictError);
    expect((await manager.getSessionFile(TMP_DIR, id)).cwd).toBe(TMP_DIR);
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
      const store = manager.create(id, TMP_DIR, { agentName: "lead" });

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
    activeSkillNames?: string[];
  }): Promise<void> {
    await sessionFileInternals.saveSessionTranscript(
      persistedSession(input.sessionId, {
        createdAt: input.createdAt ?? 1000,
        updatedAt: input.createdAt ?? 1000,
        agentName: input.parentSessionId === undefined ? "lead" : "explore",
        activeSkillNames: input.activeSkillNames ?? [],
        title: input.title ?? null,
        rootSessionId: input.rootSessionId ?? input.sessionId,
        ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      }),
      TMP_DIR,
    );
  }

  async function readSessionJson(path: string): Promise<Record<string, unknown>> {
    return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
  }

  function canonicalSessionPath(sessionId: string): string {
    return join(TMP_DIR, ".archcode", "runtime", "sessions", sessionId, "session.json");
  }

  async function writeRawSessionFile(sessionId: string, content: string): Promise<void> {
    await mkdir(join(TMP_DIR, ".archcode", "runtime", "sessions", sessionId), { recursive: true });
    await Bun.write(canonicalSessionPath(sessionId), content);
  }

  test("create() returns the same store for the same sessionId+workspaceRoot", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store1 = manager.create(id, TMP_DIR, { agentName: "lead" });
    const store2 = manager.create(id, TMP_DIR, { agentName: "lead" });
    expect(store1).toBe(store2);
  });

  test("create() returns different stores for different sessionIds", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store1 = manager.create(sessionId(), TMP_DIR, { agentName: "lead" });
    const store2 = manager.create(sessionId(), TMP_DIR, { agentName: "lead" });
    expect(store1).not.toBe(store2);
  });

  test("create() defaults child session links to empty", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store = manager.create(sessionId(), TMP_DIR, { agentName: "lead" });

    expect(store.getState().childSessionLinks).toEqual([]);
  });

  test("create() defaults cwd to the canonical workspace root", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store = manager.create(sessionId(), TMP_DIR, { agentName: "lead" });

    expect(store.getState().cwd).toBe(TMP_DIR);
  });

  test("flushSession makes an execution-start record durable", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });
    await manager.flushSession(id, TMP_DIR);

    store.getState().append(executionStart("execution-1"));
    await manager.flushSession(id, TMP_DIR);

    const persisted = await readSessionJson(canonicalSessionPath(id));
    expect((persisted.executions as Array<{ id: string; status: string }>).at(-1)).toMatchObject({
      id: "execution-1",
      status: "running",
    });
  });

  test("persists an execution cwd independently from the canonical session directory", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const worktreeCwd = join(TMP_DIR, "..", "worktree");
    const store = manager.create(id, TMP_DIR, { cwd: worktreeCwd, agentName: "lead" });

    expect(store.getState().cwd).toBe(worktreeCwd);
    await manager.flushSession(id, TMP_DIR);
    const persisted = await readSessionJson(canonicalSessionPath(id));
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
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });
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
    expect((await manager.getSessionFile(TMP_DIR, id)).eventCursor).toBe(
      store.getState().nextEventId - 1,
    );
    expect(await Bun.file(join(worktreeCwd, ".archcode", "runtime", "sessions", id, "session.json")).exists()).toBe(false);
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
      const store = manager.create(id, TMP_DIR, { agentName: "lead" });
      await firstSaveStarted;
      store.getState().setTitle("queued before cwd transition");
      const worktreeCwd = join(TMP_DIR, "..", "queued-worktree");

      const update = manager.updateCwd(id, TMP_DIR, worktreeCwd, TMP_DIR);
      releaseFirstSave();
      await update;

      const persisted = await readSessionJson(canonicalSessionPath(id));
      expect(persisted.cwd).toBe(worktreeCwd);
      expect(persisted.title).toBe("queued before cwd transition");
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("updateCwd rejects a stale expected cwd without changing memory or disk", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });
    await manager.flushSession(id, TMP_DIR);

    await expect(manager.updateCwd(id, TMP_DIR, join(TMP_DIR, "..", "next"), "/stale/cwd"))
      .rejects.toMatchObject({ name: "InvalidSessionCwdError" });

    expect(store.getState().cwd).toBe(TMP_DIR);
    expect((await readSessionJson(canonicalSessionPath(id))).cwd).toBe(TMP_DIR);
  });

  test("create rejects a relative execution cwd", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    expect(() => manager.create(sessionId(), TMP_DIR, { cwd: "relative/worktree", agentName: "lead" }))
      .toThrow(expect.objectContaining({ name: "InvalidSessionCwdError" }));
  });

  test("compression events persist compression state to disk", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });

    store.getState().append({ type: "compression.block_committed", block: compressionBlockSnapshot() });

    await manager.flushSession(id, TMP_DIR);
    const persisted = await readSessionJson(canonicalSessionPath(id));

    const compression = persisted.compression as { blocksByRef?: Record<string, { tokenEstimate?: { savedTokens?: number } }> };
    expect(compression.blocksByRef?.b1?.tokenEstimate?.savedTokens).toBe(75);
  });

  test("get() returns undefined for unknown session", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    expect(manager.get(sessionId(), TMP_DIR)).toBeUndefined();
  });

  test("get() returns existing store after create()", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });
    expect(manager.get(id, TMP_DIR)).toBe(store);
  });

  test("has() returns correct boolean", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    expect(manager.has(id, TMP_DIR)).toBe(false);
    manager.create(id, TMP_DIR, { agentName: "lead" });
    expect(manager.has(id, TMP_DIR)).toBe(true);
  });

  test("delete() removes store from registry", () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    manager.create(id, TMP_DIR, { agentName: "lead" });
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
    manager.create(idA, TMP_DIR, { agentName: "lead" });
    manager.create(idB, TMP_DIR, { agentName: "lead" });
    manager.clearAll();
    expect(manager.has(idA, TMP_DIR)).toBe(false);
    expect(manager.has(idB, TMP_DIR)).toBe(false);
  });

  test("getOrLoad() returns existing store from registry without disk I/O", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const created = manager.create(id, TMP_DIR, { agentName: "lead" });
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

  test("every durable snapshot advances the canonical updatedAt monotonically", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });
    await manager.flushSession(id, TMP_DIR);
    const first = await readSessionJson(canonicalSessionPath(id));

    store.getState().setTitle("updated");
    await manager.flushSession(id, TMP_DIR);
    const second = await readSessionJson(canonicalSessionPath(id));

    expect(second.updatedAt).toBeGreaterThan(first.updatedAt as number);
    expect(store.getState().updatedAt).toBe(second.updatedAt as number);
  });

  test("clean hydration and read projections do not rewrite Session persistence", async () => {
    const id = sessionId();
    await sessionFileInternals.saveSessionTranscript(persistedSession(id, {
      title: "stable",
      updatedAt: 1234,
    }), TMP_DIR);
    const path = canonicalSessionPath(id);
    const before = await Bun.file(path).text();

    const originalSave = sessionFileInternals.saveSessionTranscript;
    let saveCount = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      saveCount += 1;
      await originalSave(state, workspaceRoot);
    };

    try {
      const manager = new SessionStoreManager({ logger: silentLogger });
      expect((await manager.getSessionFile(TMP_DIR, id)).updatedAt).toBe(1234);
      expect(await manager.resolveSessionDepth(TMP_DIR, id)).toBe(0);
      expect((await manager.buildSessionTree(TMP_DIR, id)).root.session.updatedAt).toBe(1234);
      expect(saveCount).toBe(0);

      const loaded = await manager.getOrLoad(id, TMP_DIR);
      expect(loaded.getState().updatedAt).toBe(1234);
      expect(saveCount).toBe(0);
      expect(await Bun.file(path).text()).toBe(before);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("persists background child session completion link events", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const parentSessionId = sessionId();
    const childSessionId = sessionId();
    const store = manager.create(parentSessionId, TMP_DIR, { agentName: "lead" });
    const link: ToolChildSessionLink = {
      parentSessionId,
      parentToolCallId: "tool-call-1",
      toolName: "delegate",
      childSessionId,
      childExecutionId: "child-execution-1",
      childAgentName: "explore",
      childProfile: "fast",
      childSkillNames: [],
      title: "Background child",
      depth: 1,
      background: true,
      status: "completed" as const,
      createdAt: 100,
      startedAt: 110,
      endedAt: 210,
      durationMs: 100,
      durationUpdatedAt: 210,
    };

    store.getState().append({ type: "tool-child-session-link", link });

    await manager.flushSession(parentSessionId, TMP_DIR);
    const raw = await readSessionJson(canonicalSessionPath(parentSessionId));
    expect(raw.childSessionLinks).toEqual([link]);

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(parentSessionId, TMP_DIR);
    expect(loaded.getState().childSessionLinks).toEqual([link]);
  });

  test("pure store hydration preserves attempted tools for execution-manager recovery", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });

    store.getState().append(executionStart("run-1"));
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
    await manager.flushSession(id, TMP_DIR);
    const raw = await readSessionJson(filePath);
    expect(JSON.stringify(raw)).toContain("attempt-1");

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    const tool = loaded.getState().messages[0]?.parts[0];
    expect(tool).toMatchObject({
      type: "tool",
      state: "running",
      toolCallId: "call-1",
      attemptId: "attempt-1",
    });
    expect(tool).not.toHaveProperty("result");
  });

  test("persists a running Bash projection without its transient live output", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });

    store.getState().append(executionStart("run-live-output"));
    store.getState().append({
      type: "tool-call",
      toolCallId: "bash-live",
      toolName: "bash",
      input: { command: "printf live", description: "Emit live output" },
    });
    store.getState().append({
      type: "tool-output-delta",
      toolCallId: "bash-live",
      toolName: "bash",
      delta: "LIVE_ONLY_SENTINEL",
      omittedBytes: 0,
      liveLimitReached: false,
    });
    expect(store.getState().messages[0]?.parts[0]).toMatchObject({
      state: "running",
      liveOutput: { preview: "LIVE_ONLY_SENTINEL" },
    });

    store.getState().append({
      type: "tool-attempt",
      toolCallId: "bash-live",
      toolName: "bash",
      attemptId: "attempt-live",
      timestamp: 123,
      destructive: true,
    });
    await manager.flushSession(id, TMP_DIR);

    const persisted = await readSessionJson(canonicalSessionPath(id));
    const persistedPart = (persisted.messages as Array<{ parts: Array<Record<string, unknown>> }>)[0]?.parts[0];
    expect(persistedPart).toMatchObject({
      state: "running",
      toolCallId: "bash-live",
      attemptId: "attempt-live",
    });
    expect(persistedPart).not.toHaveProperty("liveOutput");
  });

  test("persists and reloads partial tool input for Registry recovery", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });

    store.getState().append(executionStart("run-partial-input"));
    store.getState().append({
      type: "tool-input-start",
      toolCallId: "call-partial",
      toolName: "file_write",
    });
    store.getState().append(executionEnd(store, "aborted"));

    const filePath = canonicalSessionPath(id);
    await manager.flushSession(id, TMP_DIR);
    const raw = await readSessionJson(filePath);
    const rawMessages = raw.messages as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(rawMessages[0]?.parts[0]).toMatchObject({
      type: "tool",
      state: "interrupted",
    });

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    expect(loaded.getState().messages[0]?.parts[0]).toMatchObject({
      type: "tool",
      state: "interrupted",
    });
  });

  test("canonicalizes undefined tool-call input in the durable message and restores the runtime cursor", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });

    store.getState().append(executionStart("run-undefined-input"));
    store.getState().append({
      type: "tool-call",
      toolCallId: "call-undefined",
      toolName: "file_write",
      input: undefined,
    });
    store.getState().append(executionEnd(store, "aborted"));

    const filePath = canonicalSessionPath(id);
    await manager.flushSession(id, TMP_DIR);
    const raw = await readSessionJson(filePath);
    const rawMessages = raw.messages as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(rawMessages[0]?.parts[0]?.input).toBeNull();
    expect(raw.eventCursor).toBe(store.getState().nextEventId - 1);

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    expect(loaded.getState().messages[0]?.parts[0]).toMatchObject({
      type: "tool",
      state: "interrupted",
      input: null,
    });
    expect(loaded.getState().events).toEqual([]);
    expect(loaded.getState().nextEventId).toBe(Number(raw.eventCursor) + 1);
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
            runOrdinal: 0,
          },
        ],
        executions: [runningExecution("run-1")],
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
    expect(loaded.getState().executions[0]).toMatchObject({ status: "running" });
  });

  test("load reconciliation makes an unfinished command outcome indeterminate", async () => {
    const id = sessionId();
    await sessionFileInternals.saveSessionTranscript(persistedSession(id, {
      inputRequestReceipts: [{
        kind: "command",
        clientRequestId: "interrupted-command",
        requestFingerprint: "user-command",
        status: "executing",
        requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
      }],
    }), TMP_DIR);

    const restarted = new SessionStoreManager({ logger: silentLogger });
    expect((await restarted.getOrLoad(id, TMP_DIR)).getState().inputRequestReceipts).toEqual([
      expect.objectContaining({
        kind: "command",
        clientRequestId: "interrupted-command",
        status: "indeterminate",
        error: expect.stringContaining("unknown"),
      }),
    ]);
  });

  test("load repairs interrupted tool projections from the durable checkpoint exactly once", async () => {
    const scenarios = [
      { id: sessionId(), isError: false, projection: "running", state: "completed", counter: "completed" },
      { id: sessionId(), isError: true, projection: "interrupted", state: "error", counter: "failed" },
    ] as const;
    for (const scenario of scenarios) {
      await sessionFileInternals.saveSessionTranscript(persistedCheckpointSession({
        id: scenario.id,
        isError: scenario.isError,
        projection: scenario.projection,
      }), TMP_DIR);
    }
    const runningCheckpointFile = await readSessionJson(canonicalSessionPath(scenarios[0].id));
    const runningCheckpointPart = (
      runningCheckpointFile.messages as Array<{ parts: Array<Record<string, unknown>> }>
    )[0]?.parts[0];
    expect(runningCheckpointPart).toMatchObject({
      state: "running",
      toolCallId: "call-checkpoint",
    });
    expect(runningCheckpointPart).not.toHaveProperty("liveOutput");

    const originalSave = sessionFileInternals.saveSessionTranscript;
    let repairSaveCount = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      repairSaveCount += 1;
      await originalSave(state, workspaceRoot);
    };

    try {
      for (const [index, scenario] of scenarios.entries()) {
        const manager = new SessionStoreManager({ logger: silentLogger });
        const loaded = await manager.getOrLoad(scenario.id, TMP_DIR);
        const part = loaded.getState().messages[0]?.parts[0];
        expect(part).toMatchObject({
          type: "tool",
          state: scenario.state,
          endedAt: 1400,
          result: { isError: scenario.isError },
        });
        expect(loaded.getState().stats.tools[scenario.counter]).toBe(1);

        const persisted = await readSessionJson(canonicalSessionPath(scenario.id));
        const persistedPart = (persisted.messages as Array<{ parts: Array<Record<string, unknown>> }>)[0]?.parts[0];
        expect(persistedPart).toMatchObject({
          state: scenario.state,
          endedAt: 1400,
          result: { isError: scenario.isError },
        });

        const restarted = new SessionStoreManager({ logger: silentLogger });
        const reloaded = await restarted.getOrLoad(scenario.id, TMP_DIR);
        expect(reloaded.getState().stats.tools[scenario.counter]).toBe(1);
        expect(repairSaveCount).toBe(index + 1);
      }
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("load treats an identical settled checkpoint as a no-op", async () => {
    const id = sessionId();
    await sessionFileInternals.saveSessionTranscript(persistedCheckpointSession({
      id,
      isError: false,
      projection: "settled",
    }), TMP_DIR);

    const originalSave = sessionFileInternals.saveSessionTranscript;
    let saveCount = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      saveCount += 1;
      await originalSave(state, workspaceRoot);
    };

    try {
      const manager = new SessionStoreManager({ logger: silentLogger });
      const loaded = await manager.getOrLoad(id, TMP_DIR);
      expect(loaded.getState().messages[0]?.parts[0]).toMatchObject({
        state: "completed",
        endedAt: 1400,
      });
      expect(loaded.getState().stats.tools.completed).toBe(1);
      expect(saveCount).toBe(0);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("load strictly rejects settled projection timestamp and result conflicts", async () => {
    const timestampConflictId = sessionId();
    await sessionFileInternals.saveSessionTranscript(persistedCheckpointSession({
      id: timestampConflictId,
      isError: false,
      projection: "settled",
      projectedSettledAt: 1399,
    }), TMP_DIR);
    const resultConflictId = sessionId();
    await sessionFileInternals.saveSessionTranscript(persistedCheckpointSession({
      id: resultConflictId,
      isError: false,
      projection: "settled",
      projectedResult: finalizedResult("conflicting projection"),
    }), TMP_DIR);

    await expect(
      new SessionStoreManager({ logger: silentLogger }).getOrLoad(timestampConflictId, TMP_DIR),
    ).rejects.toThrow("conflicts with its settled ToolPart projection");
    await expect(
      new SessionStoreManager({ logger: silentLogger }).getOrLoad(resultConflictId, TMP_DIR),
    ).rejects.toThrow("conflicts with its settled ToolPart projection");
  });

  test("persists completed tool results and does not downgrade them on restart", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });

    store.getState().append(executionStart("run-1"));
    store.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "file_write", input: { path: "a.ts" } });
    store.getState().append({
      type: "tool-attempt",
      toolCallId: "call-1",
      toolName: "file_write",
      attemptId: "attempt-1",
      timestamp: 123,
      destructive: true,
    });
    const settledAt = 456;
    store.getState().append({ type: "tool-result", toolCallId: "call-1", toolName: "file_write", settledAt, result: finalizedResult("written") });

    const filePath = canonicalSessionPath(id);
    await manager.flushSession(id, TMP_DIR);

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    const tool = loaded.getState().messages[0]?.parts[0];
    expect(tool).toMatchObject({
      type: "tool",
      state: "completed",
      toolCallId: "call-1",
      result: { output: { preview: "written" } },
      attemptId: "attempt-1",
      endedAt: settledAt,
    });
    expect(JSON.stringify(tool)).not.toContain("unknownResult");
  });

  test("persists execution-error in session JSON file", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });
    const errorMsg = "Execution terminated due to terminal failure";

    store.getState().append(executionStart("run-1"));
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "execution-error", step: 0, error: errorMsg });

    const filePath = canonicalSessionPath(id);
    await manager.flushSession(id, TMP_DIR);
    const raw = await readSessionJson(filePath);
    expect(JSON.stringify(raw)).toContain(errorMsg);
  });

  test("restarted SessionStoreManager reloads execution error in steps", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });
    const errorMsg = "model crashed in step 0";

    store.getState().append(executionStart("run-1"));
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "execution-error", step: 0, error: errorMsg });

    const filePath = canonicalSessionPath(id);
    await manager.flushSession(id, TMP_DIR);

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    const stepWithError = loaded.getState().steps.find((s) => s.error !== undefined);
    expect(stepWithError).toBeDefined();
    expect(stepWithError!.error).toBe(errorMsg);
  });

  test("persists Prompt traces independently and reloads an empty runtime ring", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const id = sessionId();
    const store = manager.create(id, TMP_DIR, { agentName: "lead" });
    const trace = {
      version: "2" as const,
      status: "compiled" as const,
      hash: "a".repeat(64),
      sections: [{ name: "Runtime Envelope", source: "runtime/snapshot", hash: "b".repeat(64) }],
      skills: { status: "present" as const, active: [{ name: "review-work", source: "/skills/review-work/SKILL.md" }] },
      visibleTools: ["file_read"],
      agentsMd: "present" as const,
      memory: "absent" as const,
      mcp: { context7: "partial-warning" as const },
      warnings: ["one MCP tool was skipped"],
    };

    store.getState().append({ type: "prompt-trace", trace });
    await manager.flushSession(id, TMP_DIR);
    const persisted = await readSessionJson(canonicalSessionPath(id));
    expect(persisted.promptTraces).toEqual([trace]);

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const loaded = await restarted.getOrLoad(id, TMP_DIR);
    expect(loaded.getState().promptTraces).toEqual([trace]);
    expect(loaded.getState().events).toEqual([]);
    expect(loaded.getState().nextEventId).toBe(Number(persisted.eventCursor) + 1);
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

  test("create() persists child sessions in their canonical directory", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    manager.create(rootSessionId, TMP_DIR, { agentName: "lead" });

    const childStore = manager.create(childSessionId, TMP_DIR, {
      rootSessionId,
      parentSessionId: rootSessionId,
      title: "child-title", agentName: "lead"
    });
    await manager.getSessionFile(TMP_DIR, childSessionId);

    expect(childStore.getState()).toMatchObject({
      sessionId: childSessionId,
      rootSessionId,
      parentSessionId: rootSessionId,
      title: "child-title",
    });
    await manager.flushSession(childSessionId, TMP_DIR);
    const childPath = canonicalSessionPath(childSessionId);
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
    const created = manager.create(sessionId, TMP_DIR, { agentName: "lead" });
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
    const liveStore = manager.create(sessionId, TMP_DIR, { agentName: "lead" });
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
    expect(tree.root.session.agentName).toBe("lead");
    expect(tree.root.children).toEqual([]);
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

    await writeRawSessionFile(rootMismatchId, JSON.stringify(sessionFileInternals.toSessionFile(persistedSession(rootMismatchId, {
      agentName: "explore",
      title: "bad-root",
      rootSessionId: otherRootId,
      parentSessionId: rootSessionId,
    }))));
    await writeRawSessionFile(mismatchFileId, JSON.stringify(sessionFileInternals.toSessionFile(persistedSession(mismatchJsonId, {
      agentName: "explore",
      title: "mismatch",
      rootSessionId,
      parentSessionId: rootSessionId,
    }))));
    await writeRawSessionFile(invalidJsonId, "not json");

    await expect(manager.buildSessionTree(TMP_DIR, rootSessionId)).rejects.toBeInstanceOf(SessionTreeIntegrityError);
  });

  test("buildSessionTree() fails on an invalid descendant schema", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const fileSessionId = sessionId();
    const jsonSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root" });
    await writeRawSessionFile(fileSessionId, JSON.stringify(sessionFileInternals.toSessionFile(persistedSession(jsonSessionId, {
      agentName: "explore",
      title: "invalid-node",
      todos: [{ id: "a", content: "first", status: "in_progress" }, { id: "b", content: "second", status: "in_progress" }],
      rootSessionId,
      parentSessionId: rootSessionId,
    }))));

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
    await writeRawSessionFile(duplicateDirSessionId, JSON.stringify(sessionFileInternals.toSessionFile(persistedSession(rootSessionId, {
      agentName: "explore",
      title: "duplicate-root",
      rootSessionId,
      parentSessionId: rootSessionId,
    }))));

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

  test("buildSessionTree() rejects a descendant with an unknown field", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId, title: "root" });
    await writeRawSessionFile(childSessionId, JSON.stringify({ ...sessionFileInternals.toSessionFile(persistedSession(childSessionId, {
      rootSessionId,
      parentSessionId: rootSessionId,
    })), unexpectedField: true }));

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
    const sessionsDirEntries = await readdir(join(TMP_DIR, ".archcode", "runtime", "sessions"), { withFileTypes: true });
    expect(sessionsDirEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)).toEqual([]);
    expect(sessionsDirEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()).toEqual([
      childSessionId,
      grandchildSessionId,
      rootSessionId,
      siblingSessionId,
    ].sort());

    const childAsRootManager = new SessionStoreManager({ logger: silentLogger });
    await Bun.write(join(TMP_DIR, ".archcode", "runtime", "sessions", `${childSessionId}.json`), JSON.stringify({
      ...childFile,
      rootSessionId: childSessionId,
      parentSessionId: rootSessionId,
    }));
    await expect(childAsRootManager.getSessionFile(TMP_DIR, childSessionId)).resolves.toMatchObject({ rootSessionId });
    await expect(childAsRootManager.buildSessionTree(TMP_DIR, childSessionId)).rejects.toThrow(NotRootSessionError);
  });

  test("persists canonical Skill names and derives depth from the parent chain after restart", async () => {
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    const grandchildSessionId = sessionId();
    await writeSessionFile({ sessionId: rootSessionId });
    await writeSessionFile({
      sessionId: childSessionId,
      rootSessionId,
      parentSessionId: rootSessionId,
      activeSkillNames: ["codemap"],
    });
    await writeSessionFile({
      sessionId: grandchildSessionId,
      rootSessionId,
      parentSessionId: childSessionId,
      activeSkillNames: ["git-master"],
    });
    const restarted = new SessionStoreManager({ logger: silentLogger });
    expect((await restarted.getSessionFile(TMP_DIR, childSessionId)).activeSkillNames).toEqual(["codemap"]);
    const invalidSiblingId = sessionId();
    await writeRawSessionFile(invalidSiblingId, JSON.stringify({ sessionId: invalidSiblingId }));
    expect(await restarted.resolveSessionDepth(TMP_DIR, rootSessionId)).toBe(0);
    expect(await restarted.resolveSessionDepth(TMP_DIR, childSessionId)).toBe(1);
    expect(await restarted.resolveSessionDepth(TMP_DIR, grandchildSessionId)).toBe(2);
  });

  test("resolveSessionDepth fails closed on a cycle in the requested ancestor chain", async () => {
    const rootSessionId = sessionId();
    const childSessionId = sessionId();
    await writeSessionFile({
      sessionId: rootSessionId,
      rootSessionId,
      parentSessionId: childSessionId,
    });
    await writeSessionFile({
      sessionId: childSessionId,
      rootSessionId,
      parentSessionId: rootSessionId,
    });

    const restarted = new SessionStoreManager({ logger: silentLogger });
    await expect(restarted.resolveSessionDepth(TMP_DIR, childSessionId)).rejects.toThrow(SessionTreeIntegrityError);
  });
});
