import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getAssistantText, SessionFileSchema, sessionFileInternals } from "./helpers";
import { storeManager } from "./store";
import { __setSessionsDirForTest } from "./sessions-dir";
import { createEmptySessionStats, type SessionExecutionRecord, type SessionStats, type ToolChildSessionLink } from "@archcode/protocol";
import type { CompactionPart, Reminder, SessionRole, SessionStoreState, StepInfo, StoredMessage, StoredPart, StoredTodo, SystemNoticePart } from "./types";
import { createEmptyCompressionState, type CompressionState } from "../compression";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "helpers", crypto.randomUUID());
const TEST_BINDING = {
  selection: { model: "test:model" }, providerId: "test", modelId: "model",
  providerDisplayName: "Test", modelDisplayName: "Model",
  resolution: "agent_default" as const, modelRuntimeRevision: "runtime-1",
};
const executionStart = (executionId: string) => ({
  type: "execution-start" as const, executionId, binding: TEST_BINDING, origin: "user_message" as const,
});
const sessionIds = new Set<string>();

afterAll(async () => {
  __setSessionsDirForTest(undefined);
  await rm(TMP_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all([...sessionIds].map((sessionId) => storeManager.flushSession(sessionId, TMP_DIR)));
  sessionIds.clear();
  storeManager.clearAll();
  __setSessionsDirForTest(undefined);
});

beforeEach(async () => {
  storeManager.clearAll();
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  __setSessionsDirForTest(() => TMP_DIR);
});

function uniqueSessionId(label: string): string {
  void label;
  const sessionId = crypto.randomUUID();
  sessionIds.add(sessionId);
  return sessionId;
}

function sessionFilePath(sessionId: string): string {
  return join(TMP_DIR, sessionId, "session.json");
}

async function writeSessionFile(sessionId: string, data: unknown): Promise<void> {
  await mkdir(join(TMP_DIR, sessionId), { recursive: true });
  await Bun.write(
    sessionFilePath(sessionId),
    JSON.stringify(
      data,
      (_key, value: unknown) => {
        if (value instanceof Set) return Array.from(value);
        if (value instanceof Map) return Array.from(value.entries());
        return value;
      },
      2,
    ),
  );
}

async function writeRawSessionFile(sessionId: string, content: string): Promise<void> {
  await mkdir(join(TMP_DIR, sessionId), { recursive: true });
  await Bun.write(sessionFilePath(sessionId), content);
}

function textPart(id: string, text: string, completedAt?: number): StoredPart {
  return completedAt === undefined
    ? { type: "text", id, text, createdAt: 100 }
    : { type: "text", id, text, createdAt: 100, completedAt };
}

function sampleMessages(): StoredMessage[] {
  return [
    {
      id: "user-1",
      role: "user",
      parts: [textPart("user-text-1", "hello", 101)],
      createdAt: 100,
      completedAt: 101,
      executionId: "run-1",
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [textPart("assistant-text-1", "world", 103)],
      createdAt: 102,
      completedAt: 104,
      executionId: "run-1",
    },
  ];
}

function allPartVariantsMessage(): StoredMessage {
  return {
    id: "assistant-all-parts",
    role: "assistant",
    createdAt: 200,
    completedAt: 220,
    executionId: "run-all",
    parts: [
      { type: "text", id: "text-complete", text: "done", createdAt: 201, completedAt: 202 },
      { type: "text", id: "text-incomplete", text: "streaming", createdAt: 203, meta: { interrupted: true, discardedFromContext: true } },
      { type: "reasoning", id: "reasoning-complete", text: "because", createdAt: 204, completedAt: 205 },
      { type: "tool", state: "pending", id: "tool-pending", toolCallId: "call-pending", toolName: "read", createdAt: 206 },
      { type: "tool", state: "running", id: "tool-running", toolCallId: "call-running", toolName: "bash", input: { cmd: "pwd" }, createdAt: 207, startedAt: 208 },
      { type: "tool", state: "completed", id: "tool-completed", toolCallId: "call-completed", toolName: "write", input: { path: "a.ts" }, output: "ok", createdAt: 209, startedAt: 210, endedAt: 211 },
      { type: "tool", state: "error", id: "tool-error", toolCallId: "call-error", toolName: "edit", input: "bad", errorMessage: "failed", createdAt: 212, startedAt: 213, endedAt: 214 },
    ],
  };
}

function sampleSteps(): StepInfo[] {
  return [
    {
      id: "step-1",
      step: 1,
      executionId: "run-1",
      startedAt: 300,
      completedAt: 310,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    },
  ];
}

function sampleTodos(): StoredTodo[] {
  return [
    { id: "todo-1", content: "first", status: "completed", createdAt: 400, updatedAt: 410 },
    { id: "todo-2", content: "second", status: "in_progress", createdAt: 420 },
  ];
}

function sampleReminders(): Reminder[] {
  return [
    {
      id: "reminder-1",
      source: {
        type: "todo_step_reminder",
        pendingTodos: [{ id: "pending-todo", content: "resume this", status: "pending", createdAt: 500 }],
      },
      delivery: "auto_inject",
      content: "Continue pending todo",
      payload: { reason: "test" },
      createdAt: 600,
      consumedAt: null,
      targetSessionId: "target-session",
    },
    {
      id: "reminder-2",
      source: { type: "subagent_completed", sessionId: "child-1" },
      delivery: "on_demand",
      sessionId: "parent-session",
      terminalState: "done",
      content: "Child completed",
      createdAt: 610,
      consumedAt: 620,
    },
  ];
}

function sampleChildSessionLinks(): ToolChildSessionLink[] {
  return [
    {
      parentSessionId: "parent-session",
      parentToolCallId: "tool-call-1",
      toolName: "delegate",
      childSessionId: "child-session",
      childAgentName: "explore",
      title: "Explore task",
      description: "Look up details",
      depth: 1,
      background: true,
      status: "completed",
      createdAt: 700,
      startedAt: 710,
      endedAt: 760,
      durationMs: 50,
      summary: "Found answer",
    },
  ];
}

type PersistedSessionState = Pick<
  SessionStoreState,
  | "sessionId"
  | "createdAt"
  | "updatedAt"
  | "cwd"
  | "agentName"
  | "activeSkillNames"
  | "modelSelection"
  | "title"
  | "messages"
  | "pendingMessages"
  | "inputRequestReceipts"
  | "steps"
  | "stats"
  | "executions"
  | "compression"
  | "todos"
  | "reminders"
  | "childSessionLinks"
  | "toolBatches"
  | "rootSessionId"
  | "parentSessionId"
  | "goalId"
  | "sessionRole"
>;

function persistedState(
  sessionId: string,
  messages = sampleMessages(),
  steps = sampleSteps(),
  todos = sampleTodos(),
  stats: SessionStats = createEmptySessionStats(),
  executions: SessionExecutionRecord[] = [],
  reminders: Reminder[] = [],
  rootSessionId?: string,
  parentSessionId: string | undefined = undefined,
  childSessionLinks: ToolChildSessionLink[] = [],
  goalId: string | undefined = undefined,
  sessionRole: SessionRole | undefined = undefined,
  compression: CompressionState = createEmptyCompressionState(),
): PersistedSessionState {
  return {
    sessionId,
    createdAt: 99,
    updatedAt: 99,
    cwd: TMP_DIR,
    agentName: "engineer",
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    title: null,
    messages,
    pendingMessages: [],
    inputRequestReceipts: [],
    steps,
    stats,
    executions,
    compression,
    todos,
    reminders,
    childSessionLinks,
    toolBatches: [],
    rootSessionId: rootSessionId ?? sessionId,
    parentSessionId,
    goalId,
    sessionRole,
  };
}

function appendCanonicalUserMessage(store: { getState(): SessionStoreState }, content: string): void {
  const id = crypto.randomUUID();
  const executionId = store.getState().currentExecutionId ?? `direct-${id}`;
  store.getState().append({
    type: "session.messages_committed",
    executionId,
    messages: [{
      id,
      role: "user",
      parts: [{ type: "text", id: `${id}:text`, text: content, createdAt: 1, completedAt: 1 }],
      createdAt: 1,
      completedAt: 1,
      executionId,
      clientRequestId: `request-${id}`,
    }],
  });
}

function compressionSummary(childBlockRefs: CompressionState["activeBlockRefs"] = []) {
  return {
    childBlockRefs,
    sections: {
      "Current Objective": "Keep the implementation moving",
      "User Constraints": "Stay inside store scope",
      "Decisions Made": "Use projection-only refs",
      "Open Tasks": "Run targeted tests",
      "Important Files": "packages/agent-core/src/store/projection.ts",
      "Tool Results": "No tools in this summary",
      "Errors/Unknown Results": "None",
      "Protected Refs": "m0003 is protected",
      "Child Block Refs": childBlockRefs.length === 0 ? "None" : childBlockRefs.map((ref) => `(${ref})`).join(" "),
      "Resume Instructions": "Continue after the compressed block",
    },
  };
}

function richCompressionState(): CompressionState {
  return {
    ...createEmptyCompressionState(),
    refMap: {
      messageRefsById: { "msg-1": "m0001", "msg-2": "m0002", "msg-3": "m0003" },
      messageIdsByRef: { m0001: "msg-1", m0002: "msg-2", m0003: "msg-3" },
      blockRefsById: { "block-active": "b1", "block-inactive": "b2", "block-superseded": "b3" },
      blockIdsByRef: { b1: "block-active", b2: "block-inactive", b3: "block-superseded" },
      nextMessageIndex: 4,
      nextBlockIndex: 4,
    },
    blocksByRef: {
      b1: {
        id: "block-active",
        ref: "b1",
        status: "active",
        strategy: "dynamic-range",
        trigger: "model_tool_call",
        range: { startMessageId: "msg-1", endMessageId: "msg-2", startRef: "m0001", endRef: "m0002", startIndex: 0, endIndex: 1 },
        summary: compressionSummary(),
        protectedRefs: [{ ref: "m0003", kind: "latest_tail", reason: "Latest tail stays visible", messageId: "msg-3", partId: "part-3" }],
        childBlockRefs: [],
        tokenEstimate: { originalTokens: 1200, summaryTokens: 200, savedTokens: 1000, estimatedAt: 5000 },
        createdAt: 4000,
        updatedAt: 5000,
      },
      b2: {
        id: "block-inactive",
        ref: "b2",
        status: "inactive",
        strategy: "dynamic-range",
        trigger: "soft_nudge_response",
        range: { startMessageId: "msg-1", endMessageId: "msg-1", startRef: "m0001", endRef: "m0001", startIndex: 0, endIndex: 0 },
        summary: compressionSummary(),
        protectedRefs: [],
        childBlockRefs: [],
        createdAt: 3000,
        updatedAt: 3500,
        deactivatedAt: 3600,
      },
      b3: {
        id: "block-superseded",
        ref: "b3",
        status: "superseded",
        strategy: "dynamic-range",
        trigger: "model_tool_call",
        range: { startMessageId: "msg-2", endMessageId: "msg-2", startRef: "m0002", endRef: "m0002", startIndex: 1, endIndex: 1 },
        summary: compressionSummary(),
        protectedRefs: [],
        childBlockRefs: [],
        createdAt: 2000,
        updatedAt: 2500,
        deactivatedAt: 2600,
        supersededBy: "b1",
      },
    },
    activeBlockRefs: ["b1"],
    inactiveBlockRefs: ["b2"],
    supersededBlockRefs: ["b3"],
    protectedRefs: [{ ref: "m0003", kind: "latest_tail", reason: "Latest tail stays visible", messageId: "msg-3", partId: "part-3" }],
    failures: [{ id: "failure-1", reason: "invalid range", startRef: "m0001", endRef: "m0002", strategy: "dynamic-range", failedAt: 6000 }],
    updatedAt: 6000,
  };
}

describe("session transcript serialization", () => {
  test("save/load roundtrips sessionId, createdAt, messages, steps, stats, executions, and todos", async () => {
    const sessionId = uniqueSessionId("roundtrip");
    const stats = { ...createEmptySessionStats(), messages: { user: 1, assistant: 1, total: 2 } };
    const executions: SessionExecutionRecord[] = [{ id: "run-1", startedAt: 1, status: "completed", endedAt: 3, durationMs: 2, binding: TEST_BINDING, origin: "user_message" }];
    const state = persistedState(sessionId, sampleMessages(), sampleSteps(), sampleTodos(), stats, executions);

    await sessionFileInternals.saveSessionTranscript(state, TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().sessionId).toBe(sessionId);
    expect(loaded.getState().createdAt).toBe(state.createdAt);
    expect(loaded.getState().agentName).toBe("engineer");
    expect(loaded.getState().messages).toEqual(state.messages);
    expect(loaded.getState().steps).toEqual(state.steps);
    expect(loaded.getState().stats).toEqual(state.stats);
    expect(loaded.getState().executions).toEqual(state.executions);
    expect(loaded.getState().executionCount).toBe(state.executions.length);
    expect(loaded.getState().todos).toEqual(state.todos);
    expect(loaded.getState()).not.toHaveProperty("pendingInteractions");
    expect(loaded.getState().childSessionLinks).toEqual([]);
  });

  test("save/load roundtrips child session links", async () => {
    const sessionId = uniqueSessionId("child-session-links");
    const links = sampleChildSessionLinks();

    await sessionFileInternals.saveSessionTranscript(
      persistedState(sessionId, sampleMessages(), sampleSteps(), sampleTodos(), createEmptySessionStats(), [], [], undefined, undefined, links),
      TMP_DIR,
    );
    const raw = JSON.parse(await Bun.file(sessionFilePath(sessionId)).text()) as Record<string, unknown>;
    expect(raw.childSessionLinks).toEqual(links);

    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    expect(loaded.getState().childSessionLinks).toEqual(links);
  });

  test("save/load roundtrips agentName", async () => {
    const sessionId = uniqueSessionId("agent-name");
    const state: PersistedSessionState = { ...persistedState(sessionId), agentName: "explore" };

    await sessionFileInternals.saveSessionTranscript(state, TMP_DIR);
    const raw = JSON.parse(await Bun.file(sessionFilePath(sessionId)).text()) as Record<string, unknown>;
    expect(raw.agentName).toBe("explore");

    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    expect(loaded.getState().agentName).toBe("explore");
  });

  test("load rejects files without agentName", async () => {
    const sessionId = uniqueSessionId("missing-agent-name");
    const { agentName: _agentName, ...stateWithoutAgentName } = persistedState(sessionId);

    await writeSessionFile(sessionId, stateWithoutAgentName);

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects files without canonical activeSkillNames", async () => {
    const sessionId = uniqueSessionId("missing-active-skills");
    const { activeSkillNames: _activeSkillNames, ...stateWithoutActiveSkills } = persistedState(sessionId);

    await writeSessionFile(sessionId, stateWithoutActiveSkills);

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects duplicate canonical activeSkillNames", async () => {
    const sessionId = uniqueSessionId("duplicate-active-skills");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId),
      activeSkillNames: ["codemap", "codemap"],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects the removed legacy agent identity", async () => {
    const sessionId = uniqueSessionId("removed-legacy-agent");
    const removedAgentName = ["orches", "trator"].join("");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId),
      agentName: removedAgentName,
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects files without cwd", async () => {
    const sessionId = uniqueSessionId("missing-cwd");
    const { cwd: _cwd, ...stateWithoutCwd } = persistedState(sessionId);

    await writeSessionFile(sessionId, stateWithoutCwd);

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects the removed schemaVersion field", async () => {
    const sessionId = uniqueSessionId("removed-schema-version");
    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const raw = JSON.parse(await Bun.file(sessionFilePath(sessionId)).text()) as Record<string, unknown>;
    raw.schemaVersion = 1;
    await writeRawSessionFile(sessionId, JSON.stringify(raw));

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("Session event persistence rejects known payload types with missing or extra fields", async () => {
    const sessionId = uniqueSessionId("strict-event-payload");
    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const raw = JSON.parse(await Bun.file(sessionFilePath(sessionId)).text()) as Record<string, unknown>;

    expect(SessionFileSchema.safeParse({
      ...raw,
      events: [{ id: 1, createdAt: 1, payload: { type: "text-delta", text: "ok" } }],
    }).success).toBe(true);
    expect(SessionFileSchema.safeParse({
      ...raw,
      events: [{ id: 1, createdAt: 1, payload: {
        type: "llm-retry",
        scope: "session",
        visibility: "session",
        attempt: 1,
        errorKind: "network",
        message: "Retrying",
        nextRetryAt: 2,
      } }],
    }).success).toBe(true);
    expect(SessionFileSchema.safeParse({
      ...raw,
      events: [{ id: 1, createdAt: 1, payload: { type: "text-delta" } }],
    }).success).toBe(false);
    expect(SessionFileSchema.safeParse({
      ...raw,
      events: [{ id: 1, createdAt: 1, payload: { type: "text-start", legacy: true } }],
    }).success).toBe(false);
  });

  test("root save writes only owner-local session.json", async () => {
    const sessionId = uniqueSessionId("root-layout");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);

    expect(await Bun.file(sessionFilePath(sessionId)).exists()).toBe(true);
    expect(await Bun.file(join(TMP_DIR, `${sessionId}.json`)).exists()).toBe(false);
    expect(await Bun.file(join(TMP_DIR, sessionId, `${sessionId}.json`)).exists()).toBe(false);
  });

  test("child save writes to its own owner directory with ancestry metadata", async () => {
    const rootSessionId = uniqueSessionId("root-layout");
    const childSessionId = uniqueSessionId("child-layout");

    await sessionFileInternals.saveSessionTranscript(
      persistedState(childSessionId, sampleMessages(), sampleSteps(), sampleTodos(), createEmptySessionStats(), [], [], rootSessionId, rootSessionId),
      TMP_DIR,
    );

    expect(await Bun.file(sessionFilePath(childSessionId)).exists()).toBe(true);
    expect(await Bun.file(join(TMP_DIR, rootSessionId, `${childSessionId}.json`)).exists()).toBe(false);
    const raw = JSON.parse(await Bun.file(sessionFilePath(childSessionId)).text()) as Record<string, unknown>;
    expect(raw.rootSessionId).toBe(rootSessionId);
    expect(raw.parentSessionId).toBe(rootSessionId);
  });

  test("listSessionSummaries returns only top-level root sessions", async () => {
    const rootSessionId = uniqueSessionId("root-summary");
    const childSessionId = uniqueSessionId("child-summary");

    await sessionFileInternals.saveSessionTranscript(persistedState(rootSessionId), TMP_DIR);
    await sessionFileInternals.saveSessionTranscript(
      persistedState(childSessionId, [], [], [], createEmptySessionStats(), [], [], rootSessionId, rootSessionId),
      TMP_DIR,
    );

    const summaries = await sessionFileInternals.listSessionSummaries(TMP_DIR);

    expect(summaries.map((summary) => summary.sessionId)).toEqual([rootSessionId]);
    expect(summaries[0]?.rootSessionId).toBe(rootSessionId);
    expect(summaries[0]?.agentName).toBe("engineer");
    expect(summaries[0]?.parentSessionId).toBeUndefined();
  });

  test("listSessionSummaries includes goalId when present", async () => {
    const sessionId = uniqueSessionId("goal-summary");
    const goalId = crypto.randomUUID();

    await sessionFileInternals.saveSessionTranscript(
      persistedState(sessionId, [], [], [], createEmptySessionStats(), [], [], undefined, undefined, [], goalId),
      TMP_DIR,
    );

    const summaries = await sessionFileInternals.listSessionSummaries(TMP_DIR);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ sessionId, goalId });
  });

  test("scanDescendants returns child session to root session mappings", async () => {
    const rootSessionId = uniqueSessionId("root-scan");
    const childA = uniqueSessionId("child-a");
    const childB = uniqueSessionId("child-b");

    await sessionFileInternals.saveSessionTranscript(
      persistedState(childA, [], [], [], createEmptySessionStats(), [], [], rootSessionId, rootSessionId),
      TMP_DIR,
    );
    await sessionFileInternals.saveSessionTranscript(
      persistedState(childB, [], [], [], createEmptySessionStats(), [], [], rootSessionId, childA),
      TMP_DIR,
    );

    const descendants = await sessionFileInternals.scanDescendants(TMP_DIR, rootSessionId);

    expect(descendants).toEqual(new Map([
      [childA, rootSessionId],
      [childB, rootSessionId],
    ]));
  });

  test("scanDescendants ignores unrelated roots without warning", async () => {
    const rootSessionId = uniqueSessionId("root-scan");
    const childId = uniqueSessionId("child-scan");
    const unrelatedRootId = uniqueSessionId("unrelated-root");
    const unrelatedChildId = uniqueSessionId("unrelated-child");
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      await sessionFileInternals.saveSessionTranscript(persistedState(rootSessionId), TMP_DIR);
      await sessionFileInternals.saveSessionTranscript(
        persistedState(childId, [], [], [], createEmptySessionStats(), [], [], rootSessionId, rootSessionId),
        TMP_DIR,
      );
      await sessionFileInternals.saveSessionTranscript(persistedState(unrelatedRootId), TMP_DIR);
      await sessionFileInternals.saveSessionTranscript(
        persistedState(unrelatedChildId, [], [], [], createEmptySessionStats(), [], [], unrelatedRootId, unrelatedRootId),
        TMP_DIR,
      );

      const descendants = await sessionFileInternals.scanDescendants(TMP_DIR, rootSessionId);

      expect(descendants).toEqual(new Map([[childId, rootSessionId]]));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("scanDescendants fails closed on invalid Session files", async () => {
    const rootSessionId = uniqueSessionId("root-scan-strict");
    const childId = uniqueSessionId("child-scan-strict");
    const invalidId = uniqueSessionId("invalid-scan-strict");
    await sessionFileInternals.saveSessionTranscript(persistedState(rootSessionId), TMP_DIR);
    await sessionFileInternals.saveSessionTranscript(
      persistedState(childId, [], [], [], createEmptySessionStats(), [], [], rootSessionId, rootSessionId),
      TMP_DIR,
    );
    await writeRawSessionFile(invalidId, "{ invalid json");

    await expect(sessionFileInternals.scanDescendants(TMP_DIR, rootSessionId)).rejects.toThrow();
  });

  test("roundtrips completed text, incomplete text, reasoning, and all tool part variants", async () => {
    const sessionId = uniqueSessionId("part-variants");
    const messages = [allPartVariantsMessage()];

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    const [loadedMessage] = loaded.getState().messages;
    expect(loadedMessage).toBeDefined();
    expect(loadedMessage!.parts[1]).toMatchObject({
      type: "text",
      id: "text-incomplete",
      text: "streaming",
      createdAt: 203,
      completedAt: expect.any(Number),
      meta: { interrupted: true, discardedFromContext: true },
    });
    expect({ ...loadedMessage, parts: [loadedMessage!.parts[0], ...loadedMessage!.parts.slice(2)] }).toEqual({
      ...messages[0],
      parts: [messages[0]!.parts[0], ...messages[0]!.parts.slice(2)],
    });
  });

  test("loaded store resets transient state to safe defaults", async () => {
    const sessionId = uniqueSessionId("safe-state");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    const state = loaded.getState();

    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.currentExecutionId).toBeUndefined();
    expect(state.currentAssistantMessageId).toBeUndefined();
  });

  test("load rejects missing required stats", async () => {
    const sessionId = uniqueSessionId("missing-stats");
    const { stats: _stats, ...legacyState } = persistedState(sessionId);
    await writeSessionFile(sessionId, legacyState);

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects missing required executions", async () => {
    const sessionId = uniqueSessionId("missing-executions");
    const { executions: _executions, ...legacyState } = persistedState(sessionId);
    await writeSessionFile(sessionId, legacyState);

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("save/load roundtrips reminders", async () => {
    const sessionId = uniqueSessionId("reminders-roundtrip");
    const reminders = sampleReminders();

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, sampleMessages(), sampleSteps(), sampleTodos(), createEmptySessionStats(), [], reminders), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().reminders).toEqual(reminders);
  });

  test("load rejects missing required snapshot collections", async () => {
    for (const field of [
      "compression",
      "pendingMessages",
      "inputRequestReceipts",
      "todos",
      "reminders",
      "childSessionLinks",
    ] as const) {
      const sessionId = uniqueSessionId(`missing-${field}`);
      const state = { ...persistedState(sessionId) } as Record<string, unknown>;
      delete state[field];
      await writeSessionFile(sessionId, state);

      await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
    }
  });

  test("load rejects file without rootSessionId", async () => {
    const sessionId = uniqueSessionId("no-root-id");
    const state = persistedState(sessionId);
    const { rootSessionId: _rootSessionId, ...noRootState } = state;
    await writeSessionFile(sessionId, noRootState);

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("Session summary scans reject invalid Session files", async () => {
    const sessionId = uniqueSessionId("reject-invalid");
    const state = persistedState(sessionId);
    const { rootSessionId: _rootSessionId, ...noRootState } = state;
    await writeSessionFile(sessionId, noRootState);

    await expect(sessionFileInternals.listSessionSummaries(TMP_DIR)).rejects.toThrow();
    await expect(sessionFileInternals.scanAllSessionSummaries(TMP_DIR)).rejects.toThrow();
  });

  test("save/load serializes rootSessionId and parentSessionId", async () => {
    const sessionId = uniqueSessionId("hierarchy-roundtrip");
    const rootSessionId = crypto.randomUUID();
    const parentSessionId = crypto.randomUUID();
    const state = persistedState(
      sessionId,
      sampleMessages(),
      sampleSteps(),
      sampleTodos(),
      createEmptySessionStats(),
      [],
      sampleReminders(),
      rootSessionId,
      parentSessionId,
    );

    await sessionFileInternals.saveSessionTranscript(state, TMP_DIR);
    const raw = await Bun.file(sessionFilePath(sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(parsed.rootSessionId).toBe(rootSessionId);
    expect(parsed.parentSessionId).toBe(parentSessionId);
    expect(loaded.getState().rootSessionId).toBe(rootSessionId);
    expect(loaded.getState().parentSessionId).toBe(parentSessionId);
  });

  test("load rejects non-UUID goalId", async () => {
    const sessionId = uniqueSessionId("invalid-goal-id");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId),
      goalId: "not-a-uuid",
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("save/load serializes goalId when set", async () => {
    const sessionId = uniqueSessionId("goal-roundtrip");
    const goalId = crypto.randomUUID();
    const state = persistedState(
      sessionId,
      sampleMessages(),
      sampleSteps(),
      sampleTodos(),
      createEmptySessionStats(),
      [],
      sampleReminders(),
      undefined,
      undefined,
      [],
      goalId,
    );

    await sessionFileInternals.saveSessionTranscript(state, TMP_DIR);
    const raw = await Bun.file(sessionFilePath(sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(parsed.goalId).toBe(goalId);
    expect(loaded.getState().goalId).toBe(goalId);
  });

  test("save omits goalId when undefined", async () => {
    const sessionId = uniqueSessionId("goal-undefined");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const raw = await Bun.file(sessionFilePath(sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);

    expect("goalId" in parsed).toBe(false);
  });

  test("save/load serializes sessionRole when set", async () => {
    const sessionId = uniqueSessionId("sessionrole-roundtrip");
    const state = persistedState(
      sessionId,
      sampleMessages(),
      sampleSteps(),
      sampleTodos(),
      createEmptySessionStats(),
      [],
      sampleReminders(),
      undefined,
      undefined,
      [],
      undefined,
      "explore",
    );

    await sessionFileInternals.saveSessionTranscript(state, TMP_DIR);
    const raw = await Bun.file(sessionFilePath(sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(parsed.sessionRole).toBe("explore");
    expect(loaded.getState().sessionRole).toBe("explore");
  });

  test("child session inherits goalId with different sessionRole", async () => {
    const rootSessionId = uniqueSessionId("root-inherit");
    const childSessionId = uniqueSessionId("child-inherit");
    const goalId = crypto.randomUUID();

    await sessionFileInternals.saveSessionTranscript(
      persistedState(rootSessionId, [], [], [], createEmptySessionStats(), [], [], undefined, undefined, [], goalId, "main"),
      TMP_DIR,
    );

    await sessionFileInternals.saveSessionTranscript(
      persistedState(childSessionId, [], [], [], createEmptySessionStats(), [], [], rootSessionId, rootSessionId, [], goalId, "explore"),
      TMP_DIR,
    );

    const rootLoaded = await storeManager.getOrLoad(rootSessionId, TMP_DIR);
    const childLoaded = await storeManager.getOrLoad(childSessionId, TMP_DIR);

    expect(rootLoaded.getState().goalId).toBe(goalId);
    expect(rootLoaded.getState().sessionRole).toBe("main");
    expect(childLoaded.getState().goalId).toBe(goalId);
    expect(childLoaded.getState().sessionRole).toBe("explore");
  });

  test("loaded store preserves methods and can continue appending", async () => {
    const sessionId = uniqueSessionId("append-after-load");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, [], []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    loaded.getState().append(executionStart("run-after-load"));
    appendCanonicalUserMessage(loaded, "after load");

    const state = loaded.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe("user");
    expect(state.messages[0]?.executionId).toBe("run-after-load");
  });

  test("atomic write leaves no temporary file behind", async () => {
    const sessionId = uniqueSessionId("atomic");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const files = await readdir(TMP_DIR);

    expect(files).toContain(sessionId);
    expect(files).not.toContain(`${sessionId}.json`);
    expect(files).not.toContain(`session.${sessionId}.json.tmp`);
    expect(await Bun.file(sessionFilePath(sessionId)).exists()).toBe(true);
  });

  test("load rejects corrupted JSON", async () => {
    const sessionId = uniqueSessionId("corrupted");
    await writeRawSessionFile(sessionId, "{not json");

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects schema-invalid data", async () => {
    const sessionId = uniqueSessionId("schema-invalid");
    await writeSessionFile(sessionId, { sessionId, createdAt: "not-number", messages: [] });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown top-level fields", async () => {
    const sessionId = uniqueSessionId("unknown-top");
    await writeSessionFile(sessionId, { ...persistedState(sessionId), extra: true });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown message fields", async () => {
    const sessionId = uniqueSessionId("unknown-message");
    const [message] = sampleMessages();
    if (!message) throw new Error("Expected sample message");
    await writeSessionFile(sessionId, {
      sessionId,
      createdAt: 99,
      messages: [{ ...message, extra: true }],
      steps: [],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown part fields", async () => {
    const sessionId = uniqueSessionId("unknown-part");
    await writeSessionFile(sessionId, {
      sessionId,
      createdAt: 99,
      messages: [
        {
          id: "message",
          role: "assistant",
          createdAt: 1,
          parts: [{ type: "text", id: "part", text: "hello", createdAt: 2, completedAt: 3, extra: true }],
        },
      ],
      steps: [],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects invalid tool state", async () => {
    const sessionId = uniqueSessionId("invalid-tool-state");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      messages: [
        {
          id: "message",
          role: "assistant",
          createdAt: 1,
          parts: [{ type: "tool", state: "paused", id: "tool", toolCallId: "call", toolName: "read", createdAt: 2 }],
        },
      ],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects invalid todo status", async () => {
    const sessionId = uniqueSessionId("invalid-todo-status");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      todos: [{ id: "todo", content: "bad", status: "blocked" }],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects more than one in_progress todo", async () => {
    const sessionId = uniqueSessionId("multiple-in-progress-todos");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      todos: [
        { id: "todo-1", content: "one", status: "in_progress" },
        { id: "todo-2", content: "two", status: "in_progress" },
      ],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown todo fields", async () => {
    const sessionId = uniqueSessionId("unknown-todo-field");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      todos: [{ id: "todo", content: "bad", status: "pending", extra: true }],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects sessionId mismatch", async () => {
    const requestedSessionId = uniqueSessionId("requested");
    await writeSessionFile(requestedSessionId, persistedState(crypto.randomUUID()));

    await expect(storeManager.getOrLoad(requestedSessionId, TMP_DIR)).rejects.toThrow("Session ID mismatch");
  });

  test("load rejects invalid role", async () => {
    const sessionId = uniqueSessionId("invalid-role");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      messages: [{ id: "message", role: "system", parts: [], createdAt: 1 }],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects missing required timestamps", async () => {
    const sessionId = uniqueSessionId("missing-timestamp");
    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      messages: [{ id: "message", role: "assistant", parts: [{ type: "text", id: "part", text: "hello", completedAt: 2 }] }],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("loaded store's toModelMessages works with loaded messages", async () => {
    const sessionId = uniqueSessionId("model-messages");
    const messages: StoredMessage[] = [
      {
        id: "user",
        role: "user",
        createdAt: 1,
        completedAt: 2,
        parts: [{ type: "text", id: "user-text", text: "hello", createdAt: 1, completedAt: 2 }],
      },
      {
        id: "assistant",
        role: "assistant",
        createdAt: 3,
        completedAt: 8,
        parts: [
          { type: "text", id: "assistant-text", text: "hi", createdAt: 4, completedAt: 5 },
          { type: "tool", state: "completed", id: "tool", toolCallId: "call", toolName: "read", input: { path: "a" }, output: "content", createdAt: 5, startedAt: 6, endedAt: 7 },
        ],
      },
    ];

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages, []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().toModelMessages()).toEqual([
      { role: "user", content: expect.stringContaining("hello") },
      { role: "assistant", content: expect.arrayContaining([{ type: "text", text: "hi" }, { type: "tool-call", toolCallId: "call", toolName: "read", input: { path: "a" } }]) },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "content" } }] },
    ]);
  });

  test("save writes the new session file shape", async () => {
    const sessionId = uniqueSessionId("shape");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const raw = await Bun.file(sessionFilePath(sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);

    expect(Object.keys(parsed).sort()).toEqual([
      "activeSkillNames",
      "agentName",
      "childSessionLinks",
      "compression",
      "createdAt",
      "cwd",
      "executions",
      "inputRequestReceipts",
      "messages",
      "modelSelection",
      "pendingMessages",
      "reminders",
      "rootSessionId",
      "sessionId",
      "stats",
      "steps",
      "title",
      "todos",
      "toolBatches",
      "updatedAt",
    ]);
    expect("events" in parsed).toBe(false);
    expect("executionCount" in parsed).toBe(false);
    expect(parsed.stats).toEqual(createEmptySessionStats());
    expect(parsed.executions).toEqual([]);
    expect(parsed.todos).toEqual(sampleTodos());
    expect(parsed).not.toHaveProperty("pendingInteractions");
    expect(parsed.reminders).toEqual([]);
    expect(parsed.childSessionLinks).toEqual([]);
    expect(parsed.agentName).toBe("engineer");
    expect(parsed).not.toHaveProperty("schemaVersion");
    expect(parsed.cwd).toBe(TMP_DIR);
    expect(parsed.rootSessionId).toBe(sessionId);
  });

  test("getOrLoad resets all runtime-only fields", async () => {
    const sessionId = uniqueSessionId("runtime-fields");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    const state = loaded.getState();

    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.currentExecutionId).toBeUndefined();
    expect(state.currentAssistantMessageId).toBeUndefined();
  });

  test("getOrLoad preserves persistent fields", async () => {
    const sessionId = uniqueSessionId("persistent-fields");
    const originalMessages = sampleMessages();
    const originalSteps = sampleSteps();
    const originalTodos = sampleTodos();

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, originalMessages, originalSteps, originalTodos), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    const loadedState = loaded.getState();

    expect(loadedState.sessionId).toBe(sessionId);
    expect(loadedState.createdAt).toBe(99);
    expect(loadedState.messages).toEqual(originalMessages);
    expect(loadedState.steps).toEqual(originalSteps);
    expect(loadedState.stats).toEqual(createEmptySessionStats());
    expect(loadedState.executions).toEqual([]);
    expect(loadedState.executionCount).toBe(0);
    expect(loadedState.todos).toEqual(originalTodos);
    expect(loadedState).not.toHaveProperty("pendingInteractions");
  });

  test("load rejects legacy pendingInteractions snapshots", async () => {
    const sessionId = uniqueSessionId("legacy-pending-interactions");

    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      pendingInteractions: [{
        id: "question-1",
        type: "clarification",
        question: "Proceed?",
        askedAt: "2026-06-03T00:00:00.000Z",
        status: "pending",
      }],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown reminder fields", async () => {
    const sessionId = uniqueSessionId("unknown-reminder-field");
    const [reminder] = sampleReminders();
    if (!reminder) throw new Error("Expected sample reminder");

    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      reminders: [{ ...reminder, extra: true }],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("load rejects unknown reminder source fields", async () => {
    const sessionId = uniqueSessionId("unknown-reminder-source-field");
    const [reminder] = sampleReminders();
    if (!reminder) throw new Error("Expected sample reminder");

    await writeSessionFile(sessionId, {
      ...persistedState(sessionId, [], []),
      reminders: [
        {
          ...reminder,
          source: { ...reminder.source, extra: true },
        },
      ],
    });

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("append works after load", async () => {
    const sessionId = uniqueSessionId("append-after-load-v2");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, [], []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    loaded.getState().append(executionStart("append-work-run"));
    appendCanonicalUserMessage(loaded, "appended after load");

    const state = loaded.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe("user");
    expect(state.messages[0]?.executionId).toBe("append-work-run");
  });

  test("getOrLoad resets readSnapshots to empty Map", async () => {
    const sessionId = uniqueSessionId("read-snapshots");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().readSnapshots.size).toBe(0);
  });

  test("save excludes transient events fields from persisted file", async () => {
    const sessionId = uniqueSessionId("no-events-in-save");
    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const raw = await Bun.file(sessionFilePath(sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);

    expect("events" in parsed).toBe(false);
    expect("eventOffset" in parsed).toBe(false);
    expect("nextEventId" in parsed).toBe(false);
  });

  test("getOrLoad resets events runtime fields", async () => {
    const sessionId = uniqueSessionId("events-reset");
    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    const state = loaded.getState();

    expect(state.events).toEqual([]);
    expect(state.eventOffset).toBe(0);
    expect(state.nextEventId).toBe(0);
  });

  test("append after load uses correct nextEventId starting from 0", async () => {
    const sessionId = uniqueSessionId("append-next-event-id");
    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, [], []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().nextEventId).toBe(0);
    expect(loaded.getState().events).toHaveLength(0);

    loaded.getState().append(executionStart("first-run"));
    expect(loaded.getState().nextEventId).toBe(1);
    expect(loaded.getState().events).toHaveLength(1);
    expect(loaded.getState().events[0]?.id).toBe(0);

    appendCanonicalUserMessage(loaded, "second event");
    expect(loaded.getState().nextEventId).toBe(2);
    expect(loaded.getState().events).toHaveLength(2);
    expect(loaded.getState().events[1]?.id).toBe(1);
  });
});

describe("getAssistantText", () => {
  test("returns empty string for no messages", () => {
    expect(getAssistantText([])).toBe("");
  });

  test("concatenates completed assistant text in message and part order", () => {
    const messages: StoredMessage[] = [
      { id: "a", role: "assistant", createdAt: 1, parts: [textPart("a1", "hel", 2), textPart("a2", "lo", 3)] },
      { id: "b", role: "assistant", createdAt: 4, parts: [textPart("b1", " world", 5)] },
    ];

    expect(getAssistantText(messages)).toBe("hello world");
  });

  test("ignores user text", () => {
    const messages: StoredMessage[] = [
      { id: "user", role: "user", createdAt: 1, parts: [textPart("user-text", "ignore", 2)] },
      { id: "assistant", role: "assistant", createdAt: 3, parts: [textPart("assistant-text", "keep", 4)] },
    ];

    expect(getAssistantText(messages)).toBe("keep");
  });

  test("ignores incomplete assistant text", () => {
    const messages: StoredMessage[] = [
      { id: "assistant", role: "assistant", createdAt: 1, parts: [textPart("incomplete", "ignore"), textPart("complete", "keep", 2)] },
    ];

    expect(getAssistantText(messages)).toBe("keep");
  });

  test("ignores reasoning and tool parts", () => {
    const messages: StoredMessage[] = [allPartVariantsMessage()];

    expect(getAssistantText(messages)).toBe("done");
  });
});

describe("saveSessionTranscript error handling", () => {
  test("throws on readonly directory", async () => {
    const sessionId = uniqueSessionId("readonly-save");
    const readonlyDir = join(TMP_DIR, "readonly-save-test");
    await mkdir(readonlyDir, { recursive: true });
    await chmod(readonlyDir, 0o444);
    __setSessionsDirForTest(() => readonlyDir);

    try {
      await expect(
        sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR),
      ).rejects.toThrow();
    } finally {
      __setSessionsDirForTest(() => TMP_DIR);
      await chmod(readonlyDir, 0o755).catch(() => {});
      await rm(readonlyDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("throws on invalid path", async () => {
    const sessionId = uniqueSessionId("invalid-path-save");
    __setSessionsDirForTest(() => "/dev/null/impossible");

    try {
      await expect(
        sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR),
      ).rejects.toThrow();
    } finally {
      __setSessionsDirForTest(() => TMP_DIR);
    }
  });

  test("error messages contain useful context about the path", async () => {
    const sessionId = uniqueSessionId("error-context");
    const readonlyDir = join(TMP_DIR, "error-context-test");
    await mkdir(readonlyDir, { recursive: true });
    await chmod(readonlyDir, 0o444);
    __setSessionsDirForTest(() => readonlyDir);

    try {
      const error = await sessionFileInternals
        .saveSessionTranscript(persistedState(sessionId), TMP_DIR)
        .catch((e: unknown) => e as Error);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(readonlyDir);
    } finally {
      __setSessionsDirForTest(() => TMP_DIR);
      await chmod(readonlyDir, 0o755).catch(() => {});
      await rm(readonlyDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("compaction and meta transcript round-trip", () => {
  test("compression state roundtrip preserves refs, blocks, protected refs, and token estimates", async () => {
    const sessionId = uniqueSessionId("compression-state-roundtrip");
    const messages: StoredMessage[] = [
      { id: "msg-1", role: "user", parts: [textPart("part-1", "old user", 1)], createdAt: 1, completedAt: 1 },
      { id: "msg-2", role: "assistant", parts: [textPart("part-2", "old assistant", 2)], createdAt: 2, completedAt: 2 },
      { id: "msg-3", role: "user", parts: [textPart("part-3", "tail", 3)], createdAt: 3, completedAt: 3 },
    ];
    const compression = richCompressionState();

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages, [], [], createEmptySessionStats(), [], [], undefined, undefined, [], undefined, undefined, compression), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    const loadedCompression = loaded.getState().compression;
    if (loadedCompression === undefined) throw new Error("Expected loaded session to hydrate compression state");

    expect(loadedCompression).toEqual(compression);
    expect(loadedCompression.blocksByRef.b1?.tokenEstimate?.savedTokens).toBe(1000);
    expect(loadedCompression.protectedRefs[0]?.kind).toBe("latest_tail");
  });

  test("session files without compression are rejected", async () => {
    const sessionId = uniqueSessionId("legacy-no-compression");
    const state = persistedState(sessionId);
    const { compression: _compression, ...legacyState } = state;

    await writeSessionFile(sessionId, legacyState);
    const raw = JSON.parse(await Bun.file(sessionFilePath(sessionId)).text()) as Record<string, unknown>;

    expect("compression" in raw).toBe(false);

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("roundtrips compacted messages with compacted flag", async () => {
    const sessionId = uniqueSessionId("compacted-roundtrip");
    const messages: StoredMessage[] = [
      { id: "msg-1", role: "user", parts: [textPart("t1", "old", 1)], createdAt: 1, compacted: true },
      { id: "msg-2", role: "user", parts: [textPart("t2", "new", 2)], createdAt: 2, completedAt: 3 },
    ];

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages, []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().messages).toEqual(messages);
  });

  test("roundtrips CompactionPart in messages", async () => {
    const sessionId = uniqueSessionId("compaction-part-roundtrip");
    const compactionPart: CompactionPart = {
      type: "compaction",
      id: "cp-1",
      summary: "Summary of compacted conversation",
      tailStartId: "msg-tail",
      compactedAt: 12345,
    };
    const messages: StoredMessage[] = [
      { id: "msg-synthetic", role: "user", parts: [compactionPart], createdAt: 12345, completedAt: 12346 },
      { id: "msg-tail", role: "user", parts: [textPart("t-tail", "tail content", 12350)], createdAt: 12350, completedAt: 12351 },
    ];

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages, []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().messages).toEqual(messages);
  });

  test("roundtrips SystemNoticePart in messages", async () => {
    const sessionId = uniqueSessionId("system-notice-roundtrip");
    const noticePart: SystemNoticePart = {
      type: "system-notice",
      id: "sn-1",
      notice: "System maintenance scheduled",
      createdAt: 999,
      completedAt: 1000,
    };
    const messages: StoredMessage[] = [
      { id: "msg-notice", role: "user", parts: [noticePart, textPart("t-1", "hello", 1001)], createdAt: 999, completedAt: 1002 },
    ];

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages, []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().messages).toEqual(messages);
  });

  test("roundtrips CompletedToolPart with meta", async () => {
    const sessionId = uniqueSessionId("tool-meta-roundtrip");
    const messages: StoredMessage[] = [
      {
        id: "msg-tool",
        role: "assistant",
        parts: [{
          type: "tool",
          state: "completed",
          id: "tool-1",
          toolCallId: "call-1",
          toolName: "bash",
          input: "ls",
          output: "file.txt",
          createdAt: 100,
          startedAt: 101,
          endedAt: 102,
          meta: { exitCode: 0, durationMs: 42 },
        }],
        createdAt: 100,
        completedAt: 103,
      },
    ];

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages, []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().messages).toEqual(messages);
  });

  test("roundtrips ErrorToolPart with meta", async () => {
    const sessionId = uniqueSessionId("tool-error-meta-roundtrip");
    const messages: StoredMessage[] = [
      {
        id: "msg-tool-err",
        role: "assistant",
        parts: [{
          type: "tool",
          state: "error",
          id: "tool-2",
          toolCallId: "call-2",
          toolName: "bash",
          input: "bad",
          errorMessage: "command failed",
          createdAt: 200,
          startedAt: 201,
          endedAt: 202,
          meta: { exitCode: 1, timedOut: false },
        }],
        createdAt: 200,
        completedAt: 203,
      },
    ];

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages, []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().messages).toEqual(messages);
  });

  test("roundtrips a full compacted session with all new types", async () => {
    const sessionId = uniqueSessionId("full-compacted-session");
    const messages: StoredMessage[] = [
      {
        id: "msg-old-user",
        role: "user",
        parts: [textPart("t-old", "old question", 10)],
        createdAt: 10,
        compacted: true,
      },
      {
        id: "msg-synthetic",
        role: "user",
        parts: [{
          type: "compaction",
          id: "cp-full",
          summary: "User asked about old topic and got a response",
          tailStartId: "msg-tail",
          compactedAt: 50,
        }],
        createdAt: 50,
        completedAt: 51,
      },
      {
        id: "msg-tail",
        role: "user",
        parts: [textPart("t-new", "new question", 60)],
        createdAt: 60,
        completedAt: 61,
      },
      {
        id: "msg-assistant",
        role: "assistant",
        parts: [{
          type: "tool",
          state: "completed",
          id: "tool-full",
          toolCallId: "call-full",
          toolName: "bash",
          input: "echo hi",
          output: "hi",
          createdAt: 70,
          startedAt: 71,
          endedAt: 72,
          meta: { exitCode: 0 },
        }],
        createdAt: 70,
        completedAt: 73,
      },
    ];

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages, []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().messages).toEqual(messages);
    expect(loaded.getState().toModelMessages()[0]).toEqual({
      role: "user",
      content: expect.stringContaining("<compact-summary>\nUser asked about old topic and got a response\n</compact-summary>"),
    });
  });
});
