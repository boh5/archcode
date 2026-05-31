import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createMockStore } from "./test-helpers";
import { getAssistantText, sessionFileInternals } from "./helpers";
import { storeManager } from "./store";
import { SessionStoreManager } from "./session-store-manager";
import { __setSessionsDirForTest } from "./sessions-dir";
import { createEmptySessionStats, type SessionExecutionRecord, type SessionStats, type ToolChildSessionLink } from "@specra/protocol";
import type { CompactionPart, Reminder, SessionStoreState, StepInfo, StoredMessage, StoredPart, StoredTodo, SystemNoticePart } from "./types";

const TMP_DIR = join(import.meta.dir, "__test_tmp__");

afterAll(async () => {
  __setSessionsDirForTest(undefined);
  await rm(TMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
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
  return crypto.randomUUID();
}

function sessionFilePath(sessionId: string): string {
  return join(TMP_DIR, `${sessionId}.json`);
}

function childSessionFilePath(rootSessionId: string, sessionId: string): string {
  return join(TMP_DIR, rootSessionId, `${sessionId}.json`);
}

async function writeSessionFile(sessionId: string, data: unknown): Promise<void> {
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
      { type: "text", id: "text-incomplete", text: "streaming", createdAt: 203 },
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
  | "agentName"
  | "title"
  | "messages"
  | "steps"
  | "stats"
  | "executions"
  | "todos"
  | "reminders"
  | "childSessionLinks"
  | "rootSessionId"
  | "parentSessionId"
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
): PersistedSessionState {
  return {
    sessionId,
    createdAt: 99,
    agentName: "orchestrator",
    title: null,
    messages,
    steps,
    stats,
    executions,
    todos,
    reminders,
    childSessionLinks,
    rootSessionId: rootSessionId ?? sessionId,
    parentSessionId,
  };
}

describe("session transcript serialization", () => {
  test("save/load roundtrips sessionId, createdAt, messages, steps, stats, executions, and todos", async () => {
    const sessionId = uniqueSessionId("roundtrip");
    const stats = { ...createEmptySessionStats(), messages: { user: 1, assistant: 1, total: 2 } };
    const executions: SessionExecutionRecord[] = [{ id: "run-1", startedAt: 1, status: "completed", endedAt: 3, durationMs: 2 }];
    const state = persistedState(sessionId, sampleMessages(), sampleSteps(), sampleTodos(), stats, executions);

    await sessionFileInternals.saveSessionTranscript(state, TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().sessionId).toBe(sessionId);
    expect(loaded.getState().createdAt).toBe(state.createdAt);
    expect(loaded.getState().agentName).toBe("orchestrator");
    expect(loaded.getState().messages).toEqual(state.messages);
    expect(loaded.getState().steps).toEqual(state.steps);
    expect(loaded.getState().stats).toEqual(state.stats);
    expect(loaded.getState().executions).toEqual(state.executions);
    expect(loaded.getState().executionCount).toBe(state.executions.length);
    expect(loaded.getState().todos).toEqual(state.todos);
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

  test("save/load roundtrips agentName and accepts legacy files without it", async () => {
    const sessionId = uniqueSessionId("agent-name");
    const state = { ...persistedState(sessionId), agentName: "explore" };

    await sessionFileInternals.saveSessionTranscript(state, TMP_DIR);
    const raw = JSON.parse(await Bun.file(sessionFilePath(sessionId)).text()) as Record<string, unknown>;
    expect(raw.agentName).toBe("explore");

    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    expect(loaded.getState().agentName).toBe("explore");

    const legacySessionId = uniqueSessionId("legacy-agent-name");
    await writeSessionFile(legacySessionId, {
      sessionId: legacySessionId,
      createdAt: 100,
      title: null,
      messages: [],
      steps: [],
      stats: createEmptySessionStats(),
      executions: [],
      todos: [],
      reminders: [],
      rootSessionId: legacySessionId,
    });

    const legacyLoaded = await storeManager.getOrLoad(legacySessionId, TMP_DIR);
    expect(legacyLoaded.getState().agentName).toBe("orchestrator");
  });

  test("root save writes only the top-level session file", async () => {
    const sessionId = uniqueSessionId("root-layout");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);

    expect(await Bun.file(sessionFilePath(sessionId)).exists()).toBe(true);
    expect(await Bun.file(join(TMP_DIR, sessionId, `${sessionId}.json`)).exists()).toBe(false);
  });

  test("child save writes under root session directory", async () => {
    const rootSessionId = uniqueSessionId("root-layout");
    const childSessionId = uniqueSessionId("child-layout");

    await sessionFileInternals.saveSessionTranscript(
      persistedState(childSessionId, sampleMessages(), sampleSteps(), sampleTodos(), createEmptySessionStats(), [], [], rootSessionId, rootSessionId),
      TMP_DIR,
    );

    expect(await Bun.file(sessionFilePath(childSessionId)).exists()).toBe(false);
    expect(await Bun.file(childSessionFilePath(rootSessionId, childSessionId)).exists()).toBe(true);
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
    expect(summaries[0]?.agentName).toBe("orchestrator");
    expect(summaries[0]?.parentSessionId).toBeUndefined();
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

  test("roundtrips completed text, incomplete text, reasoning, and all tool part variants", async () => {
    const sessionId = uniqueSessionId("part-variants");
    const messages = [allPartVariantsMessage()];

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, messages), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(loaded.getState().messages).toEqual(messages);
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

  test("load defaults optional fields (reminders, parentSessionId)", async () => {
    const sessionId = uniqueSessionId("optional-fields");
    const state = persistedState(sessionId);
    const { reminders: _reminders, parentSessionId: _parentSessionId, ...noRemindersState } = state;
    await writeSessionFile(sessionId, noRemindersState);

    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    const loadedState = loaded.getState();

    expect(loadedState.reminders).toEqual([]);
    expect(loadedState.parentSessionId).toBeUndefined();
  });

  test("load rejects file without rootSessionId", async () => {
    const sessionId = uniqueSessionId("no-root-id");
    const state = persistedState(sessionId);
    const { rootSessionId: _rootSessionId, ...noRootState } = state;
    await writeSessionFile(sessionId, noRootState);

    await expect(storeManager.getOrLoad(sessionId, TMP_DIR)).rejects.toThrow();
  });

  test("listSessionSummaries skips files without rootSessionId gracefully", async () => {
    const sessionId = uniqueSessionId("skip-invalid");
    const state = persistedState(sessionId);
    const { rootSessionId: _rootSessionId, ...noRootState } = state;
    await writeSessionFile(sessionId, noRootState);

    // Should not crash, should simply skip the invalid file
    const summaries = await sessionFileInternals.listSessionSummaries(TMP_DIR);
    expect(summaries).toEqual([]);
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
    const raw = await Bun.file(childSessionFilePath(rootSessionId, sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);

    expect(parsed.rootSessionId).toBe(rootSessionId);
    expect(parsed.parentSessionId).toBe(parentSessionId);
    expect(loaded.getState().rootSessionId).toBe(rootSessionId);
    expect(loaded.getState().parentSessionId).toBe(parentSessionId);
  });

  test("loaded store preserves methods and can continue appending", async () => {
    const sessionId = uniqueSessionId("append-after-load");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId, [], []), TMP_DIR);
    const loaded = await storeManager.getOrLoad(sessionId, TMP_DIR);
    loaded.getState().append({ type: "execution-start", executionId: "run-after-load" });
    loaded.getState().append({ type: "user-message", content: "after load" });

    const state = loaded.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe("user");
    expect(state.messages[0]?.executionId).toBe("run-after-load");
  });

  test("atomic write leaves no temporary file behind", async () => {
    const sessionId = uniqueSessionId("atomic");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const files = await readdir(TMP_DIR);

    expect(files).toContain(`${sessionId}.json`);
    expect(files).not.toContain(`${sessionId}.json.tmp`);
  });

  test("load rejects corrupted JSON", async () => {
    const sessionId = uniqueSessionId("corrupted");
    await Bun.write(sessionFilePath(sessionId), "{not json");

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
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool-call", toolCallId: "call", toolName: "read", input: { path: "a" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "content" } }] },
    ]);
  });

  test("save writes the new session file shape", async () => {
    const sessionId = uniqueSessionId("shape");

    await sessionFileInternals.saveSessionTranscript(persistedState(sessionId), TMP_DIR);
    const raw = await Bun.file(sessionFilePath(sessionId)).text();
    const parsed: Record<string, unknown> = JSON.parse(raw);

    expect(Object.keys(parsed).sort()).toEqual([
      "agentName",
      "childSessionLinks",
      "createdAt",
      "executions",
      "messages",
      "reminders",
      "rootSessionId",
      "sessionId",
      "stats",
      "steps",
      "title",
      "todos",
    ]);
    expect("events" in parsed).toBe(false);
    expect("executionCount" in parsed).toBe(false);
    expect(parsed.stats).toEqual(createEmptySessionStats());
    expect(parsed.executions).toEqual([]);
    expect(parsed.todos).toEqual(sampleTodos());
    expect(parsed.reminders).toEqual([]);
    expect(parsed.childSessionLinks).toEqual([]);
    expect(parsed.agentName).toBe("orchestrator");
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
    loaded.getState().append({ type: "execution-start", executionId: "append-work-run" });
    loaded.getState().append({ type: "user-message", content: "appended after load" });

    const state = loaded.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe("user");
    expect(state.messages[0]?.executionId).toBe("append-work-run");
  });

  test("getOrLoad resets readSnapshots to empty Map", async () => {
    const sessionId = uniqueSessionId("read-snapshots");

    const store = createMockStore({ readSnapshots: new Map([["file.ts", 456]]) });

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

    loaded.getState().append({ type: "execution-start", executionId: "first-run" });
    expect(loaded.getState().nextEventId).toBe(1);
    expect(loaded.getState().events).toHaveLength(1);
    expect(loaded.getState().events[0]?.id).toBe(0);

    loaded.getState().append({ type: "user-message", content: "second event" });
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
      content: "<compact-summary>\nUser asked about old topic and got a response\n</compact-summary>",
    });
  });
});
