import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats, type CompressionBlockSnapshot } from "@archcode/protocol";
import { BusyError, InvalidTodoStateError, type CompactionPart, type ReasoningPart, type Reminder, type StepInfo, type StoredMessage, type StoredTodo, type TextPart, type ToolPart } from "./types";
import { createSessionStore, storeManager } from "./store";
import { SessionStoreManager } from "./session-store-manager";
import { silentLogger } from "../logger";
import { __setSessionsDirForTest } from "./sessions-dir";
import { COMPRESSION_SUMMARY_SECTION_NAMES } from "../compression";
import { sessionFileInternals } from "./helpers";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "store", crypto.randomUUID());
const sessionIds = new Set<string>();
const realSaveSessionTranscript = sessionFileInternals.saveSessionTranscript;
let usesInMemoryPersistence = false;
const TEST_BINDING = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "agent_default" as const,
  modelRuntimeRevision: "runtime-1",
};
const TEST_REQUESTED_MODEL_SELECTION = {
  mode: "agent_default" as const,
  selection: TEST_BINDING.selection,
};
const TEST_MODEL_AUDIT = {
  requested: TEST_REQUESTED_MODEL_SELECTION,
  actual: TEST_BINDING.selection,
};

function executionStart(executionId: string = crypto.randomUUID()) {
  return { type: "execution-start" as const, executionId, binding: TEST_BINDING, origin: "user_message" as const };
}

beforeEach(async () => {
  storeManager.clearAll();
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await Promise.all([...sessionIds].map((sessionId) => storeManager.flushSession(sessionId, TMP_DIR)));
  if (usesInMemoryPersistence) {
    sessionFileInternals.saveSessionTranscript = realSaveSessionTranscript;
    usesInMemoryPersistence = false;
  }
  sessionIds.clear();
  storeManager.clearAll();
  __setSessionsDirForTest(undefined);
});

afterAll(async () => {
  sessionFileInternals.saveSessionTranscript = realSaveSessionTranscript;
  __setSessionsDirForTest(undefined);
  await rm(TMP_DIR, { recursive: true, force: true });
});

function uniqueSessionId(label: string): string {
  void label;
  const sessionId = crypto.randomUUID();
  sessionIds.add(sessionId);
  return sessionId;
}

function createFreshStore(label: string) {
  usesInMemoryPersistence = true;
  sessionFileInternals.saveSessionTranscript = async () => {};
  return storeManager.create(uniqueSessionId(label), TMP_DIR, { agentName: "engineer" });
}

function compressionBlockSnapshot(): CompressionBlockSnapshot {
  return {
    id: "block-1",
    ref: "b1",
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    range: { startMessageId: "msg-1", endMessageId: "msg-2", startRef: "m0001", endRef: "m0002", startIndex: 0, endIndex: 1 },
    summary: "Old discussion summary",
    childBlockRefs: [],
    protectedRefs: ["m0002"],
    tokenEstimate: { originalTokens: 100, summaryTokens: 20, savedTokens: 80, estimatedAt: 123 },
    createdAt: 1000,
    updatedAt: 1001,
  };
}

function renderedStructuredSummary(): string {
  return COMPRESSION_SUMMARY_SECTION_NAMES
    .map((section) => `## ${section}\n${section} content`)
    .join("\n\n");
}

function sessionFilePath(sessionId: string): string {
  return join(TMP_DIR, sessionId, "session.json");
}

async function readPersistedSession(sessionId: string): Promise<Record<string, unknown>> {
  const path = sessionFilePath(sessionId);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await Bun.file(path).exists()) {
      return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Session file was not persisted for ${sessionId}`);
}

async function waitForPersistedSession(
  sessionId: string,
  predicate: (session: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const session = await readPersistedSession(sessionId);
    if (predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Session file did not reach expected state for ${sessionId}`);
}

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return { id: crypto.randomUUID(),
  source: { type: "todo_step_reminder", pendingTodos: [] },
  delivery: "auto_inject",
  content: "remember this",
  createdAt: Date.now(),
  consumedAt: null, ...overrides,  };
}

function onlyMessage(messages: StoredMessage[]): StoredMessage {
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

function appendUserMessage(
  store: ReturnType<typeof createFreshStore>,
  content: string,
): void {
  const sequence = store.getState().messages.length;
  const id = `user-${sequence}-${crypto.randomUUID()}`;
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
      modelAudit: TEST_MODEL_AUDIT,
    }],
  });
}

function textPart(message: StoredMessage, index = 0): TextPart {
  const part = message.parts[index];
  expect(part?.type).toBe("text");
  if (!part || part.type !== "text") throw new Error("Expected text part");
  return part;
}

function reasoningPart(message: StoredMessage, index = 0): ReasoningPart {
  const part = message.parts[index];
  expect(part?.type).toBe("reasoning");
  if (!part || part.type !== "reasoning") throw new Error("Expected reasoning part");
  return part;
}

function toolPart(message: StoredMessage, index = 0): ToolPart {
  const part = message.parts[index];
  expect(part?.type).toBe("tool");
  if (!part || part.type !== "tool") throw new Error("Expected tool part");
  return part;
}

function onlyStep(steps: StepInfo[]): StepInfo {
  expect(steps).toHaveLength(1);
  return steps[0]!;
}

describe("SessionStoreManager", () => {
  test("create returns initialized session state with empty events log", () => {
    const sessionId = uniqueSessionId("creation");
    const store = storeManager.create(sessionId, TMP_DIR, { agentName: "engineer" });
    const state = store.getState();

    expect(state.sessionId).toBe(sessionId);
    expect(state.messages).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(state.stats).toEqual(createEmptySessionStats());
    expect(state.executions).toEqual([]);
    expect(state.todos).toEqual([]);
    expect(state.createdAt).toBeGreaterThan(0);
    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.reminders).toEqual([]);
    expect(state.rootSessionId).toBe(sessionId);
    expect(state.parentSessionId).toBeUndefined();
    expect(state.events).toEqual([]);
    expect(state.eventOffset).toBe(0);
    expect(state.nextEventId).toBe(0);
  });

  test("create with goalId and sessionRole sets them on state", () => {
    const sessionId = uniqueSessionId("with-goal");
    const goalId = crypto.randomUUID();
    const store = storeManager.create(sessionId, TMP_DIR, {
      goalId,
      sessionRole: "explore", agentName: "explore"
    });
    const state = store.getState();

    expect(state.goalId).toBe(goalId);
    expect(state.sessionRole).toBe("explore");
  });

  test("setGoalId and setSessionRole persist changes", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("goal-persist");
    const store = storeManager.create(sessionId, TMP_DIR, {
      sessionRole: "main", agentName: "engineer"
    });
    const goalId = crypto.randomUUID();

    store.getState().setGoalId(goalId);
    expect(store.getState().goalId).toBe(goalId);

    const persisted = await waitForPersistedSession(sessionId, (session) => session.goalId === goalId);
    expect(persisted.goalId).toBe(goalId);
    expect(persisted.sessionRole).toBe("main");
  });

  test("createSessionStore persists a new session file", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-create");
    createSessionStore(sessionId, TMP_DIR);

    const persisted = await readPersistedSession(sessionId);
    expect(persisted.sessionId).toBe(sessionId);
    expect(persisted.messages).toEqual([]);
    expect(persisted.stats).toEqual(createEmptySessionStats());
    expect(persisted.executions).toEqual([]);
    expect("executionCount" in persisted).toBe(false);
  });

  test("assistant append events persist on execution-end", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-on-execution-end");
    const store = createSessionStore(sessionId, TMP_DIR);

    const state = store.getState();
    state.append(executionStart("run-1"));
    state.append({ type: "text-start" });
    state.append({ type: "text-delta", text: "hel" });
    state.append({ type: "text-delta", text: "lo" });
    state.append({ type: "text-end" });
    state.append({ type: "execution-end", status: "completed" });

    const persisted = await waitForPersistedSession(sessionId, (session) => {
      const messages = session.messages;
      return Array.isArray(messages) && JSON.stringify(messages).includes("hello");
    });
    expect(persisted.messages).toEqual(store.getState().messages);
  });

  test("rootSessionId persists as sessionId for root sessions", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-root-id");
    createSessionStore(sessionId, TMP_DIR);

    const persisted = await waitForPersistedSession(sessionId, (session) => {
      return session.rootSessionId === sessionId;
    });
    expect(persisted.rootSessionId).toBe(sessionId);
    expect(persisted.parentSessionId).toBeUndefined();
  });

  test("canonical message commit persists before execution-end", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-canonical-message");
    const store = createSessionStore(sessionId, TMP_DIR);
    appendUserMessage(store, "hello before execution-end");

    const persisted = await waitForPersistedSession(sessionId, (session) => {
      const messages = session.messages;
      return Array.isArray(messages) && messages.length === 1;
    });
    expect(persisted.messages).toEqual(store.getState().messages);
  });

  test("execution-end persists final transcript", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-execution-end");
    const store = createSessionStore(sessionId, TMP_DIR);
    const state = store.getState();

    state.append(executionStart("run-1"));
    state.append({ type: "text-start" });
    state.append({ type: "text-delta", text: "final answer" });
    state.append({ type: "execution-end", status: "completed" });

    const persisted = await waitForPersistedSession(sessionId, (session) => {
      const messages = session.messages;
      return Array.isArray(messages) && JSON.stringify(messages).includes("final answer");
    });
    expect(persisted.messages).toEqual(store.getState().messages);
    expect(persisted.stats).toEqual(store.getState().stats);
    expect(persisted.executions).toEqual(store.getState().executions);
    expect("executionCount" in persisted).toBe(false);
  });

  test("title metadata action persists and survives reload", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-title");
    const store = createSessionStore(sessionId, TMP_DIR);
    store.getState().setTitle("Persisted Title");

    await waitForPersistedSession(sessionId, (session) => session.title === "Persisted Title");

    const manager = new SessionStoreManager({ logger: silentLogger });
    const loaded = await manager.getOrLoad(sessionId, "ignored-by-test-override");
    expect(loaded.getState().title).toBe("Persisted Title");
  });

  test("reload from disk preserves stats and executions exactly while deriving executionCount", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-stats-executions");
    const store = createSessionStore(sessionId, TMP_DIR);
    const state = store.getState();

    state.append(executionStart("run-one"));
    appendUserMessage(store, "collect stats");
    state.append({ type: "step-start", step: 0 });
    state.append({ type: "tool-call", toolCallId: "tool-ok", toolName: "read", input: { path: "a.ts" } });
    state.append({ type: "tool-result", toolCallId: "tool-ok", toolName: "read", output: "ok", isError: false });
    state.append({ type: "step-end", step: 0, finishReason: "tool-calls", usage: { inputTokens: 2, outputTokens: 3 } });
    state.append({ type: "execution-end", status: "completed" });
    state.append(executionStart("run-two"));
    state.append({ type: "step-start", step: 0 });
    state.append({ type: "tool-call", toolCallId: "tool-fail", toolName: "bash", input: "false" });
    state.append({ type: "tool-result", toolCallId: "tool-fail", toolName: "bash", output: "failed", isError: true });
    state.append({ type: "step-end", step: 0, finishReason: "stop", usage: { inputTokens: 5, outputTokens: 7 } });
    state.append({ type: "execution-end", status: "failed", error: "child failed" });

    await waitForPersistedSession(sessionId, (session) => Array.isArray(session.executions) && session.executions.length === 2);
    const expectedStats = store.getState().stats;
    const expectedExecutions = store.getState().executions;

    const manager = new SessionStoreManager({ logger: silentLogger });
    const loaded = await manager.getOrLoad(sessionId, "ignored-by-test-override");
    const loadedState = loaded.getState();

    expect(loadedState.stats).toEqual(expectedStats);
    expect(loadedState.executions).toEqual(expectedExecutions);
    expect(loadedState.executionCount).toBe(expectedExecutions.length);
    expect(loadedState.executionCount).toBe(loadedState.executions.length);
  });

  test("create returns the same store for the same session id", () => {
    const sessionId = uniqueSessionId("same-store");
    expect(storeManager.create(sessionId, TMP_DIR, { agentName: "engineer" })).toBe(storeManager.create(sessionId, TMP_DIR, { agentName: "engineer" }));
  });

  test("create scopes stores by workspace root", () => {
    const sessionId = uniqueSessionId("scoped-store");
    const left = storeManager.create(sessionId, "/workspace/left", { agentName: "engineer" });
    const right = storeManager.create(sessionId, "/workspace/right", { agentName: "engineer" });

    expect(left).not.toBe(right);
    expect(storeManager.get(sessionId, "/workspace/left")).toBe(left);
    expect(storeManager.get(sessionId, "/workspace/right")).toBe(right);
  });

  test("get returns undefined for unknown sessions and existing stores after creation", () => {
    const sessionId = uniqueSessionId("registry");
    expect(storeManager.get(sessionId, TMP_DIR)).toBeUndefined();
    const store = storeManager.create(sessionId, TMP_DIR, { agentName: "engineer" });
    expect(storeManager.get(sessionId, TMP_DIR)).toBe(store);
  });

  test("has returns true for registered stores and false for unknown ones", () => {
    const sessionId = uniqueSessionId("has-check");
    expect(storeManager.has(sessionId, TMP_DIR)).toBe(false);
    storeManager.create(sessionId, TMP_DIR, { agentName: "engineer" });
    expect(storeManager.has(sessionId, TMP_DIR)).toBe(true);
  });

  test("delete removes a store from the registry", () => {
    const sessionId = uniqueSessionId("delete-store");
    storeManager.create(sessionId, TMP_DIR, { agentName: "engineer" });
    expect(storeManager.has(sessionId, TMP_DIR)).toBe(true);

    const result = storeManager.delete(sessionId, TMP_DIR);
    expect(result).toBe(true);
    expect(storeManager.has(sessionId, TMP_DIR)).toBe(false);
    expect(storeManager.get(sessionId, TMP_DIR)).toBeUndefined();
  });

  test("delete returns false for unknown sessions", () => {
    expect(storeManager.delete("nonexistent", TMP_DIR)).toBe(false);
  });

  test("clearAll removes all stores from the registry", () => {
    const sessionIds = [
      uniqueSessionId("clear-a"),
      uniqueSessionId("clear-b"),
      uniqueSessionId("clear-c"),
    ];
    for (const sessionId of sessionIds) storeManager.create(sessionId, TMP_DIR, { agentName: "engineer" });

    storeManager.clearAll();

    for (const sessionId of sessionIds) {
      expect(storeManager.get(sessionId, TMP_DIR)).toBeUndefined();
    }
  });

  test("clearAll on a fresh manager leaves no stores", () => {
    const fresh = new SessionStoreManager({ logger: silentLogger });
    const sessionId = uniqueSessionId("fresh-store");
    fresh.create(sessionId, TMP_DIR, { agentName: "engineer" });
    fresh.clearAll();
    expect(fresh.has(sessionId, TMP_DIR)).toBe(false);
  });
});

describe("events log", () => {
  test("append creates envelope with correct structure and updates structured state", () => {
    const store = createFreshStore("events-envelope");
    appendUserMessage(store, "hello");

    const state = store.getState();
    expect(state.events).toHaveLength(1);

    const envelope = state.events[0]!;
    expect(envelope.id).toBe(0);
    expect(envelope.createdAt).toBeGreaterThan(0);
    expect(envelope.payload.type).toBe("session.messages_committed");
    expect(envelope.payload).toMatchObject({ type: "session.messages_committed" });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe("user");
  });

  test("envelope id monotonicity increments nextEventId", () => {
    const store = createFreshStore("events-monotonic");
    appendUserMessage(store, "first");
    appendUserMessage(store, "second");
    appendUserMessage(store, "third");

    const state = store.getState();
    expect(state.events).toHaveLength(3);
    expect(state.events[0]!.id).toBe(0);
    expect(state.events[1]!.id).toBe(1);
    expect(state.events[2]!.id).toBe(2);
    expect(state.nextEventId).toBe(3);
    expect(state.eventOffset).toBe(0);
  });

  test("bounded window overflow drops oldest events and increments eventOffset", () => {
    const store = createFreshStore("events-window");

    // Append MAX_EVENTS (10000) + 1 events to trigger overflow
    for (let i = 0; i < 10001; i++) {
      store.getState().append({ type: "reminder-consumed", reminderIds: [`missing-${i}`] });
    }

    const state = store.getState();
    expect(state.events.length).toBe(10000);
    expect(state.eventOffset).toBe(1);
    expect(state.nextEventId).toBe(10001);
    // First retained event has id 1 (id 0 was dropped)
    expect(state.events[0]!.id).toBe(1);
    // Last event has id 10000
    expect(state.events[9999]!.id).toBe(10000);
  });
});

describe("executionCount", () => {
  test("initial executionCount is 0", () => {
    const store = createFreshStore("executionCount-init");
    expect(store.getState().executionCount).toBe(0);
  });

  test("after execution-start event, executionCount is 1", () => {
    const store = createFreshStore("executionCount-after-start");
    store.getState().append(executionStart());
    expect(store.getState().executionCount).toBe(1);
    expect(store.getState().executions).toHaveLength(1);
  });

  test("after two execution-start events (with execution-end between), executionCount is 2", () => {
    const store = createFreshStore("executionCount-two-executions");
    store.getState().append(executionStart());
    store.getState().append({ type: "execution-end", status: "completed" });
    store.getState().append(executionStart());
    expect(store.getState().executionCount).toBe(2);
    expect(store.getState().executionCount).toBe(store.getState().executions.length);
  });
});

describe("reminder events", () => {
  test("reminder event creates reminder with consumedAt null", () => {
    const store = createFreshStore("reminder-create");
    const reminder = makeReminder({ id: "reminder-1", consumedAt: 123 });

    store.getState().append({ type: "reminder", reminder });

    expect(store.getState().reminders).toEqual([{ ...reminder, consumedAt: null }]);
  });

  test("duplicate reminder id is deduped", () => {
    const store = createFreshStore("reminder-id-dedupe");
    const first = makeReminder({ id: "same-id", content: "first" });
    const duplicate = makeReminder({ id: "same-id", content: "duplicate" });

    store.getState().append({ type: "reminder", reminder: first });
    store.getState().append({ type: "reminder", reminder: duplicate });

    expect(store.getState().reminders).toHaveLength(1);
    expect(store.getState().reminders[0]?.content).toBe("first");
  });

  test("terminal subagent reminders are deduped by sessionId", () => {
    const store = createFreshStore("reminder-terminal-dedupe");
    const first = makeReminder({
      id: "terminal-1",
      sessionId: "child-1",
      source: { type: "subagent_completed", sessionId: "child-1" },
      content: "completed",
    });
    const duplicate = makeReminder({
      id: "terminal-2",
      sessionId: "child-1",
      source: { type: "subagent_failed", sessionId: "child-1" },
      content: "failed",
    });

    store.getState().append({ type: "reminder", reminder: first });
    store.getState().append({ type: "reminder", reminder: duplicate });

    expect(store.getState().reminders).toHaveLength(1);
    expect(store.getState().reminders[0]?.id).toBe("terminal-1");
  });

  test("reminder-consumed marks reminder consumed", () => {
    const store = createFreshStore("reminder-consume");
    const reminder = makeReminder({ id: "consume-me" });

    store.getState().append({ type: "reminder", reminder });
    store.getState().append({ type: "reminder-consumed", reminderIds: ["consume-me"] });

    expect(store.getState().reminders[0]?.consumedAt).toBeGreaterThan(0);
  });

  test("consuming unknown reminder id is an idempotent no-op", () => {
    const store = createFreshStore("reminder-consume-unknown");
    const reminder = makeReminder({ id: "known" });
    store.getState().append({ type: "reminder", reminder });
    const reminders = store.getState().reminders;

    store.getState().append({ type: "reminder-consumed", reminderIds: ["unknown"] });

    expect(store.getState().reminders).toBe(reminders);
    expect(store.getState().reminders).toEqual([{ ...reminder, consumedAt: null }]);
  });

  test("re-consuming already consumed reminder preserves first consumedAt", () => {
    const store = createFreshStore("reminder-reconsume");
    const reminder = makeReminder({ id: "consume-once" });

    store.getState().append({ type: "reminder", reminder });
    store.getState().append({ type: "reminder-consumed", reminderIds: ["consume-once"] });
    const firstConsumedAt = store.getState().reminders[0]?.consumedAt;

    store.getState().append({ type: "reminder-consumed", reminderIds: ["consume-once"] });

    expect(store.getState().reminders[0]?.consumedAt).toBe(firstConsumedAt);
  });
});

describe("todo-write events", () => {
  test("replaces the full todo list", () => {
    const store = createFreshStore("todo-replace");
    const initialTodos: StoredTodo[] = [
      { id: "todo-1", content: "first", status: "pending", createdAt: 1 },
      { id: "todo-2", content: "second", status: "in_progress", createdAt: 2, updatedAt: 3 },
    ];
    const replacementTodos: StoredTodo[] = [
      { id: "todo-3", content: "replacement", status: "completed", createdAt: 4, updatedAt: 5 },
    ];

    store.getState().append({ type: "todo-write", todos: initialTodos });
    expect(store.getState().todos).toEqual(initialTodos);

    store.getState().append({ type: "todo-write", todos: replacementTodos });
    expect(store.getState().todos).toEqual(replacementTodos);
  });

  test("invalid status throws InvalidTodoStateError without mutating todos", () => {
    const store = createFreshStore("todo-invalid-status");
    const previousTodos: StoredTodo[] = [{ id: "todo-1", content: "keep", status: "pending" }];
    store.getState().append({ type: "todo-write", todos: previousTodos });
    const previousReference = store.getState().todos;

    expect(() =>
      store.getState().append({
        type: "todo-write",
        todos: [{ id: "bad", content: "bad", status: "blocked" } as unknown as StoredTodo],
      }),
    ).toThrow(InvalidTodoStateError);

    expect(store.getState().todos).toBe(previousReference);
    expect(store.getState().todos).toEqual(previousTodos);
  });

  test("multiple in_progress todos throw InvalidTodoStateError without mutating todos", () => {
    const store = createFreshStore("todo-multiple-progress");
    const previousTodos: StoredTodo[] = [{ id: "todo-1", content: "keep", status: "completed" }];
    store.getState().append({ type: "todo-write", todos: previousTodos });
    const previousReference = store.getState().todos;

    expect(() =>
      store.getState().append({
        type: "todo-write",
        todos: [
          { id: "todo-2", content: "one", status: "in_progress" },
          { id: "todo-3", content: "two", status: "in_progress" },
        ],
      }),
    ).toThrow(InvalidTodoStateError);

    expect(store.getState().todos).toBe(previousReference);
    expect(store.getState().todos).toEqual(previousTodos);
  });

  test("invalid todo event throws a named deterministic error", () => {
    const store = createFreshStore("todo-named-error");

    try {
      store.getState().append({
        type: "todo-write",
        todos: [{ id: "bad", content: "bad", status: "paused" } as unknown as StoredTodo],
      });
      throw new Error("Expected invalid todo event to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTodoStateError);
      expect((err as Error).name).toBe("InvalidTodoStateError");
      expect((err as Error).message).toContain("invalid status");
    }
  });

  test("toModelMessages does not inject separate todo messages", () => {
    const store = createFreshStore("todo-projection");
    store.getState().append({
      type: "todo-write",
      todos: [{ id: "todo-1", content: "hidden from projection", status: "in_progress" }],
    });
    appendUserMessage(store, "hello");

    const projected = store.getState().toModelMessages();
    expect(projected).toHaveLength(1);
    expect(projected[0]!.role).toBe("user");
    expect(String(projected[0]!.content)).toContain("hello");
    expect(JSON.stringify(projected)).not.toContain("hidden from projection");
  });
});

describe("execution lifecycle", () => {
  test("execution-start sets running state and generated currentExecutionId", () => {
    const store = createFreshStore("execution-start");
    store.getState().append(executionStart());

    const state = store.getState();
    expect(state.isRunning).toBe(true);
    expect(state.currentExecutionId).toBeString();
    expect(state.currentAssistantMessageId).toBeUndefined();
    expect(state.isStreamingModel).toBe(false);
  });

  test("execution-start uses a provided executionId", () => {
    const store = createFreshStore("provided-execution-id");
    store.getState().append(executionStart("run-123"));
    expect(store.getState().currentExecutionId).toBe("run-123");
  });

  test("execution-start while running throws BusyError without mutating state", () => {
    const store = createFreshStore("busy");
    store.getState().append(executionStart("first"));
    const before = store.getState();

    expect(() => store.getState().append(executionStart("second"))).toThrow(BusyError);
    const after = store.getState();
    expect(after.currentExecutionId).toBe("first");
    expect(after.isRunning).toBe(true);
    expect(after.messages).toBe(before.messages);
    expect(after.steps).toBe(before.steps);
  });

  test("execution-end completed clears all temporary state and completes assistant message", () => {
    const store = createFreshStore("execution-end-success");
    store.getState().append(executionStart("run"));
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "hello" });
    store.getState().append({ type: "text-end" });
    store.getState().append({ type: "reasoning-start" });
    store.getState().append({ type: "tool-input-start", toolCallId: "tool", toolName: "read" });
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "execution-end", status: "completed" });

    const state = store.getState();
    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.currentExecutionId).toBeUndefined();
    expect(state.currentAssistantMessageId).toBeUndefined();
    expect(onlyMessage(state.messages).completedAt).toBeGreaterThan(0);
    expect(state.executions[0]?.status).toBe("completed");
  });

  test("execution-end failed performs the same cleanup and preserves messages", () => {
    const store = createFreshStore("execution-end-failure");
    store.getState().append(executionStart("run"));
    appendUserMessage(store, "keep me");
    const messages = store.getState().messages;
    store.getState().append({ type: "execution-end", status: "failed", error: "boom" });

    const state = store.getState();
    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.currentExecutionId).toBeUndefined();
    expect(state.currentAssistantMessageId).toBeUndefined();
    expect(state.messages).toEqual(messages);
    expect(state.executions[0]?.status).toBe("failed");
    expect(state.executions[0]?.error).toBe("boom");
  });

  test("execution-end records cancelled, aborted, and timed_out statuses", () => {
    const store = createFreshStore("execution-terminal-statuses");

    for (const status of ["cancelled", "aborted", "timed_out"] as const) {
      store.getState().append(executionStart(`run-${status}`));
      store.getState().append({ type: "execution-end", status, error: `${status} error` });
    }

    expect(store.getState().executions.map((execution) => execution.status)).toEqual(["cancelled", "aborted", "timed_out"]);
    expect(store.getState().executionCount).toBe(3);
  });

  test("command-handled completed execution records an execution without messages", () => {
    const store = createFreshStore("command-handled-execution");

    store.getState().append(executionStart("command-run"));
    store.getState().append({ type: "execution-end", status: "completed" });

    expect(store.getState().messages).toEqual([]);
    expect(store.getState().executions).toHaveLength(1);
    expect(store.getState().executions[0]?.id).toBe("command-run");
    expect(store.getState().executionCount).toBe(1);
  });
});

describe("user messages", () => {
  test("canonical message commit creates a completed user message with an executionId", () => {
    const store = createFreshStore("canonical-message");
    store.getState().append(executionStart("run-user"));
    appendUserMessage(store, "hello");

    const message = onlyMessage(store.getState().messages);
    expect(message.role).toBe("user");
    expect(message.executionId).toBe("run-user");
    expect(message.completedAt).toBeGreaterThan(0);
    const part = textPart(message);
    expect(part.text).toBe("hello");
    expect(part.completedAt).toBeGreaterThan(0);
  });

  test("multiple canonical user messages are appended in order", () => {
    const store = createFreshStore("multi-user");
    appendUserMessage(store, "first");
    appendUserMessage(store, "second");

    expect(store.getState().messages.map((message) => textPart(message).text)).toEqual(["first", "second"]);
  });
});

describe("text streaming", () => {
  test("text-start creates an assistant message and empty text part", () => {
    const store = createFreshStore("text-start");
    store.getState().append({ type: "text-start" });

    const state = store.getState();
    const message = onlyMessage(state.messages);
    const part = textPart(message);
    expect(message.role).toBe("assistant");
    expect(state.currentAssistantMessageId).toBe(message.id);
    expect(part.text).toBe("");
    expect(part.completedAt).toBeUndefined();
  });

  test("text-delta appends directly to the text part", () => {
    const store = createFreshStore("text-delta");
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "hel" });
    store.getState().append({ type: "text-delta", text: "lo" });

    const state = store.getState();
    expect(textPart(onlyMessage(state.messages)).text).toBe("hello");
  });

  test("text-end completes the text part without altering its text", () => {
    const store = createFreshStore("text-end");
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "done" });
    store.getState().append({ type: "text-end" });

    const state = store.getState();
    const part = textPart(onlyMessage(state.messages));
    expect(part.text).toBe("done");
    expect(part.completedAt).toBeGreaterThan(0);
  });

  test("text-delta without text-start implicitly starts text streaming", () => {
    const store = createFreshStore("implicit-text");
    store.getState().append({ type: "text-delta", text: "implicit" });

    const state = store.getState();
    const message = onlyMessage(state.messages);
    const part = textPart(message);
    expect(part.text).toBe("implicit");
    expect(part.completedAt).toBeUndefined();
  });

  test("text-end without streaming text does not crash", () => {
    const store = createFreshStore("text-end-noop");
    store.getState().append({ type: "text-end" });
    expect(store.getState().messages).toEqual([]);
  });

  test("multiple text-start events create multiple text parts", () => {
    const store = createFreshStore("multi-text");
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "one" });
    store.getState().append({ type: "text-end" });
    store.getState().append({ type: "text-start" });

    const message = onlyMessage(store.getState().messages);
    expect(message.parts).toHaveLength(2);
    expect(textPart(message, 0).text).toBe("one");
    expect(textPart(message, 0).completedAt).toBeGreaterThan(0);
    expect(textPart(message, 1).text).toBe("");
  });
});

describe("reasoning streaming", () => {
  test("reasoning-start creates an assistant message and empty reasoning part", () => {
    const store = createFreshStore("reasoning-start");
    store.getState().append({ type: "reasoning-start" });

    const state = store.getState();
    const message = onlyMessage(state.messages);
    const part = reasoningPart(message);
    expect(message.role).toBe("assistant");
    expect(part.text).toBe("");
  });

  test("reasoning-delta appends directly to the reasoning part", () => {
    const store = createFreshStore("reasoning-delta");
    store.getState().append({ type: "reasoning-start" });
    store.getState().append({ type: "reasoning-delta", text: "think" });

    const state = store.getState();
    expect(reasoningPart(onlyMessage(state.messages)).text).toBe("think");
  });

  test("reasoning-end completes the reasoning part without altering its text", () => {
    const store = createFreshStore("reasoning-end");
    store.getState().append({ type: "reasoning-delta", text: "because" });
    store.getState().append({ type: "reasoning-end" });

    const state = store.getState();
    const part = reasoningPart(onlyMessage(state.messages));
    expect(part.text).toBe("because");
    expect(part.completedAt).toBeGreaterThan(0);
  });

  test("reasoning before text creates the assistant message correctly", () => {
    const store = createFreshStore("reasoning-before-text");
    store.getState().append({ type: "reasoning-start" });
    store.getState().append({ type: "text-start" });

    const message = onlyMessage(store.getState().messages);
    expect(message.role).toBe("assistant");
    expect(reasoningPart(message, 0).type).toBe("reasoning");
    expect(textPart(message, 1).type).toBe("text");
  });
});

describe("tool streaming", () => {
  test("tool-input-start creates assistant message and pending tool part", () => {
    const store = createFreshStore("tool-input-start");
    store.getState().append({ type: "tool-input-start", toolCallId: "call-1", toolName: "read" });

    const state = store.getState();
    const message = onlyMessage(state.messages);
    const part = toolPart(message);
    expect(part.state).toBe("pending");
    expect(part.toolCallId).toBe("call-1");
    expect(part.toolName).toBe("read");
    expect(part.createdAt).toBeGreaterThan(0);
  });

  test("tool-call after tool-input-start transitions pending to running and stores input", () => {
    const store = createFreshStore("tool-call-after-input");
    const input = { path: "file.ts" };
    store.getState().append({ type: "tool-input-start", toolCallId: "call-1", toolName: "read" });
    store.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "read", input });

    const state = store.getState();
    const part = toolPart(onlyMessage(state.messages));
    expect(part.state).toBe("running");
    if (part.state !== "running") throw new Error("Expected running tool");
    expect(part.input).toBe(input);
    expect(part.startedAt).toBeGreaterThan(0);
  });

  test("tool-call without tool-input-start creates a running tool part directly", () => {
    const store = createFreshStore("direct-tool-call");
    store.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: "pwd" });

    const state = store.getState();
    const part = toolPart(onlyMessage(state.messages));
    expect(part.state).toBe("running");
    if (part.state !== "running") throw new Error("Expected running tool");
    expect(part.input).toBe("pwd");
    expect(part.startedAt).toBeGreaterThan(0);
  });

  test("successful tool-result completes the part, stores output, and removes streaming entry", () => {
    const store = createFreshStore("tool-result-success");
    store.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a" } });
    store.getState().append({ type: "tool-result", toolCallId: "call-1", toolName: "read", output: "content", isError: false });

    const state = store.getState();
    const part = toolPart(onlyMessage(state.messages));
    expect(part.state).toBe("completed");
    if (part.state !== "completed") throw new Error("Expected completed tool");
    expect(part.output).toBe("content");
    expect(part.endedAt).toBeGreaterThan(0);
  });

  test("error tool-result records errorMessage and endedAt", () => {
    const store = createFreshStore("tool-result-error");
    store.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: "bad" });
    store.getState().append({ type: "tool-result", toolCallId: "call-1", toolName: "bash", output: "failed", isError: true });

    const part = toolPart(onlyMessage(store.getState().messages));
    expect(part.state).toBe("error");
    if (part.state !== "error") throw new Error("Expected error tool");
    expect(part.errorMessage).toBe("failed");
    expect(part.endedAt).toBeGreaterThan(0);
  });

  test("tool-result updates the stored tool part when it already exists", () => {
    const store = createFreshStore("tool-result-fallback");
    store.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "read", input: "input" });
    store.getState().append({ type: "tool-result", toolCallId: "call-1", toolName: "read", output: "ok", isError: false });

    const part = toolPart(onlyMessage(store.getState().messages));
    expect(part.state).toBe("completed");
  });

  test("multiple tools update independently and preserve part order", () => {
    const store = createFreshStore("multi-tools");
    store.getState().append({ type: "tool-input-start", toolCallId: "a", toolName: "first" });
    store.getState().append({ type: "tool-input-start", toolCallId: "b", toolName: "second" });
    store.getState().append({ type: "tool-call", toolCallId: "b", toolName: "second", input: 2 });
    store.getState().append({ type: "tool-result", toolCallId: "b", toolName: "second", output: "two", isError: false });

    const message = onlyMessage(store.getState().messages);
    const first = toolPart(message, 0);
    const second = toolPart(message, 1);
    expect(first.toolCallId).toBe("a");
    expect(first.state).toBe("pending");
    expect(second.toolCallId).toBe("b");
    expect(second.state).toBe("completed");
  });
});

describe("settleIncompleteState behavior", () => {
  test("execution-end marks incomplete text and reasoning parts completed", () => {
    const store = createFreshStore("settle-incomplete");
    store.getState().append(executionStart("run"));
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "hello" });
    store.getState().append({ type: "reasoning-start" });
    store.getState().append({ type: "reasoning-delta", text: "why" });

    store.getState().append({ type: "execution-end", status: "completed" });

    const message = onlyMessage(store.getState().messages);
    const text = textPart(message, 0);
    const reasoning = reasoningPart(message, 1);
    expect(text.text).toBe("hello");
    expect(text.completedAt).toBeGreaterThan(0);
    expect(reasoning.text).toBe("why");
    expect(reasoning.completedAt).toBeGreaterThan(0);
    expect(message.completedAt).toBeGreaterThan(0);
  });

  test("interrupted execution settles attempted effectful tool as unknown-result", () => {
    const store = createFreshStore("unknown-result-store");
    store.getState().append(executionStart("run"));
    store.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "file_write", input: { filePath: "a.ts" } });
    store.getState().append({
      type: "tool-attempt",
      toolCallId: "call-1",
      toolName: "file_write",
      attemptId: "attempt-1",
      timestamp: 99,
      destructive: true,
    });

    store.getState().append({ type: "execution-end", status: "interrupted" });

    const tool = toolPart(onlyMessage(store.getState().messages));
    expect(tool.state).toBe("error");
    if (tool.state !== "error") throw new Error("Expected error tool");
    expect(tool.errorMessage).toBe("Tool execution result unknown: execution was interrupted");
    expect(tool.meta).toEqual({ unknownResult: true });
    expect(tool.attemptId).toBe("attempt-1");
  });
});

describe("steps and errors", () => {
  test("step-start sets isStreamingModel and creates StepInfo", () => {
    const store = createFreshStore("step-start");
    store.getState().append(executionStart("run-step"));
    store.getState().append({ type: "step-start", step: 1 });

    const state = store.getState();
    const step = onlyStep(state.steps);
    expect(state.isStreamingModel).toBe(true);
    expect(step.step).toBe(1);
    expect(step.executionId).toBe("run-step");
    expect(step.startedAt).toBeGreaterThan(0);
  });

  test("step-end stops streaming and records finishReason, usage, and completedAt", () => {
    const store = createFreshStore("step-end");
    const usage = { inputTokens: 1, outputTokens: 2 };
    store.getState().append({ type: "step-start", step: 1 });
    store.getState().append({ type: "step-end", step: 1, finishReason: "stop", usage });

    const state = store.getState();
    const step = onlyStep(state.steps);
    expect(state.isStreamingModel).toBe(false);
    expect(step.finishReason).toBe("stop");
    expect(step.usage).toBe(usage);
    expect(step.completedAt).toBeGreaterThan(0);
  });

  test("multiple steps are appended in order", () => {
    const store = createFreshStore("multi-steps");
    store.getState().append({ type: "step-start", step: 1 });
    store.getState().append({ type: "step-start", step: 2 });
    expect(store.getState().steps.map((step) => step.step)).toEqual([1, 2]);
  });

  test("execution-error records error on a matching step", () => {
    const store = createFreshStore("execution-error-match");
    store.getState().append({ type: "step-start", step: 3 });
    store.getState().append({ type: "execution-error", step: 3, error: "bad execution" });
    expect(onlyStep(store.getState().steps).error).toBe("bad execution");
  });

  test("execution-error without a matching step appends an error step", () => {
    const store = createFreshStore("execution-error-append");
    store.getState().append(executionStart("run-error"));
    store.getState().append({ type: "execution-error", step: 4, error: "missing step" });

    const step = onlyStep(store.getState().steps);
    expect(step.step).toBe(4);
    expect(step.executionId).toBe("run-error");
    expect(step.error).toBe("missing step");
    expect(step.startedAt).toBeGreaterThan(0);
  });
});

describe("Zustand integration and immutability", () => {
  test("append triggers Zustand subscribers", () => {
    const store = createFreshStore("subscriber");
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    appendUserMessage(store, "notify");
    unsubscribe();
    // One notification carries the reduced event and one carries the
    // canonical updatedAt advanced by the scheduled durable snapshot.
    expect(calls).toBe(2);
  });

  test("messages array reference changes after append", () => {
    const store = createFreshStore("immutability");
    const before = store.getState().messages;
    appendUserMessage(store, "immutable");
    expect(store.getState().messages).not.toBe(before);
  });

  test("toModelMessages delegates projection over stored messages", () => {
    const store = createFreshStore("projection");
    appendUserMessage(store, "hello");
    expect(store.getState().toModelMessages()).toEqual([
      { role: "user", content: "<message ref=\"m0001\">\nhello\n</message>" },
    ]);
  });

  test("toModelMessages materializes stable compression message refs", () => {
    const store = createFreshStore("projection-ref-map");
    appendUserMessage(store, "first");

    store.getState().toModelMessages();
    const firstRefMap = store.getState().compression!.refMap;
    const firstMessageId = store.getState().messages[0]!.id;

    expect(firstRefMap.messageRefsById[firstMessageId]).toBe("m0001");
    expect(firstRefMap.messageIdsByRef.m0001).toBe(firstMessageId);
    expect(firstRefMap.nextMessageIndex).toBe(2);

    appendUserMessage(store, "second");
    const rendered = JSON.stringify(store.getState().toModelMessages());
    const secondRefMap = store.getState().compression!.refMap;
    const secondMessageId = store.getState().messages[1]!.id;

    expect(secondRefMap.messageRefsById[firstMessageId]).toBe("m0001");
    expect(secondRefMap.messageRefsById[secondMessageId]).toBe("m0002");
    expect(secondRefMap.nextMessageIndex).toBe(3);
    expect(rendered).toContain("m0001");
    expect(rendered).toContain("m0002");
  });
});

describe("Oracle regression tests", () => {
  test("multi-step tool call creates separate assistant messages", () => {
    const store = createFreshStore("multi-step");
    store.getState().append(executionStart());
    appendUserMessage(store, "run tool");

    // Step 0: assistant calls a tool
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "I'll run it" });
    store.getState().append({ type: "text-end" });
    store.getState().append({ type: "tool-input-start", toolCallId: "tc-1", toolName: "bash" });
    store.getState().append({ type: "tool-call", toolCallId: "tc-1", toolName: "bash", input: "ls" });
    store.getState().append({ type: "step-end", step: 0, finishReason: "tool-calls" });

    store.getState().append({ type: "tool-result", toolCallId: "tc-1", toolName: "bash", output: "file.txt", isError: false });

    // Step 1: should create a NEW assistant message (not merge into step 0's)
    store.getState().append({ type: "step-start", step: 1 });
    const messagesBeforeStep1 = store.getState().messages;
    const step0Assistant = messagesBeforeStep1.find(m => m.role === "assistant");
    expect(step0Assistant).toBeDefined();

    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "Here's the result" });
    store.getState().append({ type: "text-end" });
    store.getState().append({ type: "step-end", step: 1, finishReason: "stop" });
    store.getState().append({ type: "execution-end", status: "completed" });

    // Two distinct assistant messages — tool-call in one, final text in another
    const messages = store.getState().messages;
    const assistantMessages = messages.filter(m => m.role === "assistant");
    expect(assistantMessages.length).toBe(2);

    const modelMessages = store.getState().toModelMessages();
    // Order: user, assistant(tool-call), tool(result), assistant(final text)
    expect(modelMessages[0]!.role).toBe("user");
    expect(modelMessages[1]!.role).toBe("assistant");
    expect(modelMessages[2]!.role).toBe("tool");
    expect(modelMessages[3]!.role).toBe("assistant");
  });

  test("second execution's step-end does not update first execution's step", () => {
    const store = createFreshStore("cross-execution-step");

    // Execution 1
    store.getState().append(executionStart());
    appendUserMessage(store, "first");
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "first response" });
    store.getState().append({ type: "text-end" });
    store.getState().append({ type: "step-end", step: 0, finishReason: "stop" });
    store.getState().append({ type: "execution-end", status: "completed" });

    // Execution 2 with same step number
    store.getState().append(executionStart());
    appendUserMessage(store, "second");
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "step-end", step: 0, finishReason: "stop" });
    store.getState().append({ type: "execution-end", status: "completed" });

    const run2Steps = store.getState().steps;
    // Both executions' step 0 should still have their original data
    expect(run2Steps.length).toBe(2);
    expect(run2Steps[0]!.executionId).not.toBe(run2Steps[1]!.executionId);
  });

  test("partial text preserved when stream errors after text-delta", () => {
    const store = createFreshStore("stream-error-text");
    store.getState().append(executionStart());
    appendUserMessage(store, "prompt");
    store.getState().append({ type: "step-start", step: 0 });

    // Start text streaming, then simulate error (execution-end handles cleanup)
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "partial" });

    // consumeFullStream's finally block would flush text-end,
    // then execution-error records the failure, then execution-end settles incomplete state
    store.getState().append({ type: "text-end" }); // flushed by try/finally
    store.getState().append({ type: "execution-error", step: 0, error: "stream failed" });
    store.getState().append({ type: "execution-end", status: "failed" });

    // Partial text should be persisted (not lost)
    const assistantMsg = store.getState().messages.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const textParts = assistantMsg!.parts.filter(p => p.type === "text");
    expect(textParts.length).toBe(1);
    expect(textParts[0]!.text).toBe("partial");
    expect(textParts[0]!.completedAt).toBeDefined();
  });

  test("duplicate text-start flushes previous text part", () => {
    const store = createFreshStore("dup-text-start");
    store.getState().append(executionStart());
    appendUserMessage(store, "prompt");
    store.getState().append({ type: "step-start", step: 0 });

    // First text section
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "First " });

    // Duplicate text-start should finalize the first and start a second
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "Second" });
    store.getState().append({ type: "text-end" });

    const assistantMsg = store.getState().messages.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const textParts = assistantMsg!.parts.filter(p => p.type === "text");
    // Should have two text parts: first completed, second streaming
    expect(textParts.length).toBe(2);
    expect(textParts[0]!.completedAt).toBeDefined();
  });

  test("failed execution settles pending/running tools as error", () => {
    const store = createFreshStore("failed-execution-tools");
    store.getState().append(executionStart());
    appendUserMessage(store, "use tool");
    store.getState().append({ type: "step-start", step: 0 });

    store.getState().append({ type: "tool-input-start", toolCallId: "tc-1", toolName: "bash" });
    store.getState().append({ type: "tool-call", toolCallId: "tc-1", toolName: "bash", input: "ls" });

    // Execution ends before tool-result arrives
    store.getState().append({ type: "execution-error", step: 0, error: "model crashed" });
    store.getState().append({ type: "execution-end", status: "failed" });

    const assistantMsg = store.getState().messages.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const toolParts = assistantMsg!.parts.filter(p => p.type === "tool");
    expect(toolParts.length).toBe(1);
    expect(toolParts[0]!.state).toBe("error");
    if (toolParts[0]!.type === "tool" && toolParts[0]!.state === "error") {
      expect(toolParts[0]!.errorMessage).toBe("Execution ended before tool result");
    }
  });
});

describe("meta propagation through tool-result event", () => {
  test("tool-result with meta propagates to CompletedToolPart", () => {
    const store = createFreshStore("meta-completed");
    store.getState().append({ type: "tool-call", toolCallId: "call-meta-1", toolName: "bash", input: "ls" });
    store.getState().append({
      type: "tool-result",
      toolCallId: "call-meta-1",
      toolName: "bash",
      output: "file.txt",
      isError: false,
      meta: { exitCode: 0 },
    });

    const part = toolPart(onlyMessage(store.getState().messages));
    expect(part.state).toBe("completed");
    if (part.state !== "completed") throw new Error("Expected completed");
    expect(part.meta).toEqual({ exitCode: 0 });
  });

  test("tool-result with meta propagates to ErrorToolPart", () => {
    const store = createFreshStore("meta-error");
    store.getState().append({ type: "tool-call", toolCallId: "call-meta-2", toolName: "bash", input: "bad" });
    store.getState().append({
      type: "tool-result",
      toolCallId: "call-meta-2",
      toolName: "bash",
      output: "command not found",
      isError: true,
      meta: { exitCode: 127 },
    });

    const part = toolPart(onlyMessage(store.getState().messages));
    expect(part.state).toBe("error");
    if (part.state !== "error") throw new Error("Expected error");
    expect(part.meta).toEqual({ exitCode: 127 });
  });

  test("tool-result without meta does not add meta field", () => {
    const store = createFreshStore("meta-absent");
    store.getState().append({ type: "tool-call", toolCallId: "call-no-meta", toolName: "read", input: {} });
    store.getState().append({
      type: "tool-result",
      toolCallId: "call-no-meta",
      toolName: "read",
      output: "ok",
      isError: false,
    });

    const part = toolPart(onlyMessage(store.getState().messages));
    expect(part.state).toBe("completed");
    if (part.state !== "completed") throw new Error("Expected completed");
    expect(part.meta).toBeUndefined();
  });
});

describe("compact event", () => {
  test("compact event marks prefix messages as compacted and inserts synthetic message", () => {
    const store = createFreshStore("compact-basic");
    appendUserMessage(store, "old question");
    store.getState().append(executionStart());
    appendUserMessage(store, "new question");

    const messages = store.getState().messages;
    const tailId = messages[1]!.id;

    store.getState().append({
      type: "compact",
      summary: "User asked about old topic",
      tailStartId: tailId,
    });

    const state = store.getState();
    expect(state.messages[0]!.compacted).toBe(true);
    expect(state.messages[1]!.compacted).toBeUndefined();

    const compactionMsg = state.messages.find((m) =>
      m.parts.some((p) => p.type === "compaction"),
    );
    expect(compactionMsg).toBeDefined();
    expect(compactionMsg!.compacted).toBeUndefined();

    const compactionPart = compactionMsg!.parts.find((p) => p.type === "compaction") as CompactionPart;
    expect(compactionPart.summary).toBe("User asked about old topic");
    expect(compactionPart.tailStartId).toBe(tailId);
  });

  test("compact event with unknown tailStartId compacts all messages", () => {
    const store = createFreshStore("compact-unknown-tail");
    appendUserMessage(store, "message 1");
    appendUserMessage(store, "message 2");

    store.getState().append({
      type: "compact",
      summary: "Everything compacted",
      tailStartId: "nonexistent-id",
    });

    const state = store.getState();
    expect(state.messages[0]!.compacted).toBe(true);
    expect(state.messages[1]!.compacted).toBe(true);
  });

  test("second compact event replaces existing compaction part", () => {
    const store = createFreshStore("compact-replace");
    appendUserMessage(store, "very old");
    appendUserMessage(store, "old");
    appendUserMessage(store, "recent");

    const messages = store.getState().messages;
    const firstTailId = messages[1]!.id;
    const secondTailId = messages[2]!.id;

    store.getState().append({
      type: "compact",
      summary: "First summary",
      tailStartId: firstTailId,
    });

    const afterFirst = store.getState().messages;
    expect(afterFirst.filter((m) => m.compacted).length).toBeGreaterThanOrEqual(1);

    store.getState().append({
      type: "compact",
      summary: "Second summary",
      tailStartId: secondTailId,
    });

    const state = store.getState();
    const compactionMessages = state.messages.filter((m) =>
      m.parts.some((p) => p.type === "compaction"),
    );
    expect(compactionMessages).toHaveLength(1);

    const compactionPart = compactionMessages[0]!.parts.find((p) => p.type === "compaction") as CompactionPart;
    expect(compactionPart.summary).toBe("Second summary");
    expect(compactionPart.tailStartId).toBe(secondTailId);
  });

  test("synthetic compaction message is not marked compacted", () => {
    const store = createFreshStore("compact-not-compacted");
    appendUserMessage(store, "old");
    appendUserMessage(store, "new");

    const tailId = store.getState().messages[1]!.id;

    store.getState().append({
      type: "compact",
      summary: "Summary",
      tailStartId: tailId,
    });

    const compactionMsg = store.getState().messages.find((m) =>
      m.parts.some((p) => p.type === "compaction"),
    );
    expect(compactionMsg).toBeDefined();
    expect(compactionMsg!.compacted).toBeUndefined();
  });
});

describe("compression events", () => {
  test("compression.block_committed updates durable compression state without compacted flags", () => {
    const store = createFreshStore("compression-commit");
    appendUserMessage(store, "old");
    appendUserMessage(store, "tail");

    store.getState().append({ type: "compression.block_committed", block: compressionBlockSnapshot() });

    const state = store.getState();
    const compression = state.compression;
    if (compression === undefined) throw new Error("Expected compression event to materialize compression state");

    expect(compression.activeBlockRefs).toEqual(["b1"]);
    expect(compression.blocksByRef.b1?.summary.sections["Current Objective"]).toBe("Old discussion summary");
    expect(compression.blocksByRef.b1?.tokenEstimate?.savedTokens).toBe(80);
    expect(compression.protectedRefs[0]?.ref).toBe("m0002");
    expect(state.messages.some((message) => message.compacted === true)).toBe(false);
  });

  test("compression.block_committed preserves rendered structured summaries without fallback sections", () => {
    const store = createFreshStore("compression-structured-summary");
    appendUserMessage(store, "old");
    appendUserMessage(store, "tail");

    store.getState().append({
      type: "compression.block_committed",
      block: { ...compressionBlockSnapshot(), summary: renderedStructuredSummary() },
    });

    const rendered = JSON.stringify(store.getState().toModelMessages());
    const currentObjectiveMatches = rendered.match(/## Current Objective/g) ?? [];

    expect(currentObjectiveMatches).toHaveLength(1);
    expect(rendered).toContain("Current Objective content");
    expect(rendered).toContain("Resume Instructions content");
    expect(rendered).not.toContain("## Current Objective\\n## Current Objective");
    expect(rendered).not.toContain("Not provided by compression snapshot");
  });

  test("compact event clears dynamic compression state before model projection", () => {
    const store = createFreshStore("compact-clears-dynamic-compression");
    appendUserMessage(store, "old");
    appendUserMessage(store, "tail");
    store.getState().append({ type: "compression.block_committed", block: compressionBlockSnapshot() });

    expect(store.getState().compression?.activeBlockRefs).toEqual(["b1"]);

    store.getState().append({ type: "compact", summary: "summary", tailStartId: "missing" });

    expect(store.getState().compression?.activeBlockRefs).toEqual([]);
    expect(store.getState().compression?.blocksByRef).toEqual({});
    expect(JSON.stringify(store.getState().toModelMessages())).not.toContain("compression-block");
    expect(JSON.stringify(store.getState().toModelMessages())).toContain("compact-summary");
  });
});
