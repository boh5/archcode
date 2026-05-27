import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BusyError, InvalidTodoStateError, type CompactionPart, type ReasoningPart, type Reminder, type StepInfo, type StoredMessage, type StoredTodo, type TextPart, type ToolPart } from "./types";
import { createSessionStore, storeManager } from "./store";
import { SessionStoreManager } from "./session-store-manager";
import { silentLogger } from "../logger";
import { __setSessionsDirForTest } from "./sessions-dir";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "store");

beforeEach(async () => {
  storeManager.clearAll();
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(() => {
  __setSessionsDirForTest(undefined);
});

afterAll(async () => {
  __setSessionsDirForTest(undefined);
  await rm(TMP_DIR, { recursive: true, force: true });
});

function uniqueSessionId(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

function createFreshStore(label: string) {
  return storeManager.create(uniqueSessionId(label));
}

function sessionFilePath(sessionId: string): string {
  return join(TMP_DIR, `${sessionId}.json`);
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
  return {
    id: crypto.randomUUID(),
    source: { type: "todo_step_reminder", pendingTodos: [] },
    delivery: "auto_inject",
    content: "remember this",
    createdAt: Date.now(),
    consumedAt: null,
    ...overrides,
  };
}

function onlyMessage(messages: StoredMessage[]): StoredMessage {
  expect(messages).toHaveLength(1);
  return messages[0]!;
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
    const store = storeManager.create(sessionId);
    const state = store.getState();

    expect(state.sessionId).toBe(sessionId);
    expect(state.messages).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(state.todos).toEqual([]);
    expect(state.createdAt).toBeGreaterThan(0);
    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.reminders).toEqual([]);
    expect(state.childSessionIds).toBeInstanceOf(Set);
    expect(state.childSessionIds.size).toBe(0);
    expect(state.parentSessionId).toBeUndefined();
    expect(state.subAgentDescriptions).toBeInstanceOf(Map);
    expect(state.subAgentDescriptions.size).toBe(0);
    expect(state.events).toEqual([]);
    expect(state.eventOffset).toBe(0);
    expect(state.nextEventId).toBe(0);
  });

  test("createSessionStore persists a new session file", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-create");
    createSessionStore(sessionId);

    const persisted = await readPersistedSession(sessionId);
    expect(persisted.sessionId).toBe(sessionId);
    expect(persisted.messages).toEqual([]);
  });

  test("user-message append persists before run-end", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-user-message");
    const store = createSessionStore(sessionId);
    store.getState().append({ type: "user-message", content: "hello before run-end" });

    const persisted = await waitForPersistedSession(sessionId, (session) => {
      const messages = session.messages;
      return Array.isArray(messages) && messages.length === 1;
    });
    expect(persisted.messages).toEqual(store.getState().messages);
  });

  test("run-end persists final transcript", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-run-end");
    const store = createSessionStore(sessionId);
    const state = store.getState();

    state.append({ type: "run-start", runId: "run-1" });
    state.append({ type: "text-start" });
    state.append({ type: "text-delta", text: "final answer" });
    state.append({ type: "run-end", status: "completed" });

    const persisted = await waitForPersistedSession(sessionId, (session) => {
      const messages = session.messages;
      return Array.isArray(messages) && JSON.stringify(messages).includes("final answer");
    });
    expect(persisted.messages).toEqual(store.getState().messages);
  });

  test("title metadata action persists and survives reload", async () => {
    __setSessionsDirForTest(() => TMP_DIR);
    const sessionId = uniqueSessionId("persist-title");
    const store = createSessionStore(sessionId);
    store.getState().setTitle("Persisted Title");

    await waitForPersistedSession(sessionId, (session) => session.title === "Persisted Title");

    const manager = new SessionStoreManager({ logger: silentLogger });
    const loaded = await manager.getOrLoad(sessionId, "ignored-by-test-override");
    expect(loaded.getState().title).toBe("Persisted Title");
  });

  test("create returns the same store for the same session id", () => {
    const sessionId = uniqueSessionId("same-store");
    expect(storeManager.create(sessionId)).toBe(storeManager.create(sessionId));
  });

  test("create scopes stores by workspace root when provided", () => {
    const sessionId = uniqueSessionId("scoped-store");
    const left = storeManager.create(sessionId, "/workspace/left");
    const right = storeManager.create(sessionId, "/workspace/right");

    expect(left).not.toBe(right);
    expect(storeManager.get(sessionId, "/workspace/left")).toBe(left);
    expect(storeManager.get(sessionId, "/workspace/right")).toBe(right);
  });

  test("get returns undefined for unknown sessions and existing stores after creation", () => {
    const sessionId = uniqueSessionId("registry");
    expect(storeManager.get(sessionId)).toBeUndefined();
    const store = storeManager.create(sessionId);
    expect(storeManager.get(sessionId)).toBe(store);
  });

  test("has returns true for registered stores and false for unknown ones", () => {
    const sessionId = uniqueSessionId("has-check");
    expect(storeManager.has(sessionId)).toBe(false);
    storeManager.create(sessionId);
    expect(storeManager.has(sessionId)).toBe(true);
  });

  test("delete removes a store from the registry", () => {
    const sessionId = uniqueSessionId("delete-store");
    storeManager.create(sessionId);
    expect(storeManager.has(sessionId)).toBe(true);

    const result = storeManager.delete(sessionId);
    expect(result).toBe(true);
    expect(storeManager.has(sessionId)).toBe(false);
    expect(storeManager.get(sessionId)).toBeUndefined();
  });

  test("delete returns false for unknown sessions", () => {
    expect(storeManager.delete("nonexistent")).toBe(false);
  });

  test("clearAll removes all stores from the registry", () => {
    storeManager.create(uniqueSessionId("clear-a"));
    storeManager.create(uniqueSessionId("clear-b"));
    storeManager.create(uniqueSessionId("clear-c"));

    storeManager.clearAll();

    expect(storeManager.get("clear-a")).toBeUndefined();
    expect(storeManager.get("clear-b")).toBeUndefined();
    expect(storeManager.get("clear-c")).toBeUndefined();
  });

  test("clearAll on a fresh manager leaves no stores", () => {
    const fresh = new SessionStoreManager({ logger: silentLogger });
    fresh.create(uniqueSessionId("fresh-store"));
    fresh.clearAll();
    expect(fresh.has("fresh-store")).toBe(false);
  });
});

describe("events log", () => {
  test("append creates envelope with correct structure and updates structured state", () => {
    const store = createFreshStore("events-envelope");
    store.getState().append({ type: "user-message", content: "hello" });

    const state = store.getState();
    expect(state.events).toHaveLength(1);

    const envelope = state.events[0]!;
    expect(envelope.id).toBe(0);
    expect(envelope.createdAt).toBeGreaterThan(0);
    expect(envelope.kind).toBe("user-message");
    expect(envelope.payload).toEqual({ type: "user-message", content: "hello" });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe("user");
  });

  test("envelope id monotonicity increments nextEventId", () => {
    const store = createFreshStore("events-monotonic");
    store.getState().append({ type: "user-message", content: "first" });
    store.getState().append({ type: "user-message", content: "second" });
    store.getState().append({ type: "user-message", content: "third" });

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
      store.getState().append({ type: "user-message", content: `event-${i}` });
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

describe("runCount", () => {
  test("initial runCount is 0", () => {
    const store = createFreshStore("runCount-init");
    expect(store.getState().runCount).toBe(0);
  });

  test("after run-start event, runCount is 1", () => {
    const store = createFreshStore("runCount-after-start");
    store.getState().append({ type: "run-start" });
    expect(store.getState().runCount).toBe(1);
  });

  test("after two run-start events (with run-end between), runCount is 2", () => {
    const store = createFreshStore("runCount-two-runs");
    store.getState().append({ type: "run-start" });
    store.getState().append({ type: "run-end", status: "completed" });
    store.getState().append({ type: "run-start" });
    expect(store.getState().runCount).toBe(2);
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
    store.getState().append({ type: "user-message", content: "hello" });

    const projected = store.getState().toModelMessages();
    expect(projected).toEqual([{ role: "user", content: "hello" }]);
    expect(JSON.stringify(projected)).not.toContain("hidden from projection");
  });
});

describe("run lifecycle", () => {
  test("run-start sets running state and generated currentRunId", () => {
    const store = createFreshStore("run-start");
    store.getState().append({ type: "run-start" });

    const state = store.getState();
    expect(state.isRunning).toBe(true);
    expect(state.currentRunId).toBeString();
    expect(state.currentAssistantMessageId).toBeUndefined();
    expect(state.isStreamingModel).toBe(false);
  });

  test("run-start uses a provided runId", () => {
    const store = createFreshStore("provided-run-id");
    store.getState().append({ type: "run-start", runId: "run-123" });
    expect(store.getState().currentRunId).toBe("run-123");
  });

  test("run-start while running throws BusyError without mutating state", () => {
    const store = createFreshStore("busy");
    store.getState().append({ type: "run-start", runId: "first" });
    const before = store.getState();

    expect(() => store.getState().append({ type: "run-start", runId: "second" })).toThrow(BusyError);
    const after = store.getState();
    expect(after.currentRunId).toBe("first");
    expect(after.isRunning).toBe(true);
    expect(after.messages).toBe(before.messages);
    expect(after.steps).toBe(before.steps);
  });

  test("run-end completed clears all temporary state and completes assistant message", () => {
    const store = createFreshStore("run-end-success");
    store.getState().append({ type: "run-start", runId: "run" });
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "hello" });
    store.getState().append({ type: "text-end" });
    store.getState().append({ type: "reasoning-start" });
    store.getState().append({ type: "tool-input-start", toolCallId: "tool", toolName: "read" });
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "run-end", status: "completed" });

    const state = store.getState();
    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.currentRunId).toBeUndefined();
    expect(state.currentAssistantMessageId).toBeUndefined();
    expect(onlyMessage(state.messages).completedAt).toBeGreaterThan(0);
  });

  test("run-end failed performs the same cleanup and preserves messages", () => {
    const store = createFreshStore("run-end-failure");
    store.getState().append({ type: "run-start", runId: "run" });
    store.getState().append({ type: "user-message", content: "keep me" });
    const messages = store.getState().messages;
    store.getState().append({ type: "run-end", status: "failed", error: "boom" });

    const state = store.getState();
    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
    expect(state.currentRunId).toBeUndefined();
    expect(state.currentAssistantMessageId).toBeUndefined();
    expect(state.messages).toEqual(messages);
  });
});

describe("user messages", () => {
  test("user-message creates a completed user message with a completed text part and runId", () => {
    const store = createFreshStore("user-message");
    store.getState().append({ type: "run-start", runId: "run-user" });
    store.getState().append({ type: "user-message", content: "hello" });

    const message = onlyMessage(store.getState().messages);
    expect(message.role).toBe("user");
    expect(message.runId).toBe("run-user");
    expect(message.completedAt).toBeGreaterThan(0);
    const part = textPart(message);
    expect(part.text).toBe("hello");
    expect(part.completedAt).toBeGreaterThan(0);
  });

  test("multiple user-messages are appended in order", () => {
    const store = createFreshStore("multi-user");
    store.getState().append({ type: "user-message", content: "first" });
    store.getState().append({ type: "user-message", content: "second" });

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
  test("run-end marks incomplete text and reasoning parts completed", () => {
    const store = createFreshStore("settle-incomplete");
    store.getState().append({ type: "run-start", runId: "run" });
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "hello" });
    store.getState().append({ type: "reasoning-start" });
    store.getState().append({ type: "reasoning-delta", text: "why" });

    store.getState().append({ type: "run-end", status: "completed" });

    const message = onlyMessage(store.getState().messages);
    const text = textPart(message, 0);
    const reasoning = reasoningPart(message, 1);
    expect(text.text).toBe("hello");
    expect(text.completedAt).toBeGreaterThan(0);
    expect(reasoning.text).toBe("why");
    expect(reasoning.completedAt).toBeGreaterThan(0);
    expect(message.completedAt).toBeGreaterThan(0);
  });
});

describe("steps and errors", () => {
  test("step-start sets isStreamingModel and creates StepInfo", () => {
    const store = createFreshStore("step-start");
    store.getState().append({ type: "run-start", runId: "run-step" });
    store.getState().append({ type: "step-start", step: 1 });

    const state = store.getState();
    const step = onlyStep(state.steps);
    expect(state.isStreamingModel).toBe(true);
    expect(step.step).toBe(1);
    expect(step.runId).toBe("run-step");
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

  test("loop-error records error on a matching step", () => {
    const store = createFreshStore("loop-error-match");
    store.getState().append({ type: "step-start", step: 3 });
    store.getState().append({ type: "loop-error", step: 3, error: "bad loop" });
    expect(onlyStep(store.getState().steps).error).toBe("bad loop");
  });

  test("loop-error without a matching step appends an error step", () => {
    const store = createFreshStore("loop-error-append");
    store.getState().append({ type: "run-start", runId: "run-error" });
    store.getState().append({ type: "loop-error", step: 4, error: "missing step" });

    const step = onlyStep(store.getState().steps);
    expect(step.step).toBe(4);
    expect(step.runId).toBe("run-error");
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

    store.getState().append({ type: "user-message", content: "notify" });
    unsubscribe();
    expect(calls).toBe(1);
  });

  test("messages array reference changes after append", () => {
    const store = createFreshStore("immutability");
    const before = store.getState().messages;
    store.getState().append({ type: "user-message", content: "immutable" });
    expect(store.getState().messages).not.toBe(before);
  });

  test("toModelMessages delegates projection over stored messages", () => {
    const store = createFreshStore("projection");
    store.getState().append({ type: "user-message", content: "hello" });
    expect(store.getState().toModelMessages()).toEqual([
      { role: "user", content: "hello" },
    ]);
  });
});

describe("Oracle regression tests", () => {
  test("multi-step tool call creates separate assistant messages", () => {
    const store = createFreshStore("multi-step");
    store.getState().append({ type: "run-start" });
    store.getState().append({ type: "user-message", content: "run tool" });

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
    store.getState().append({ type: "run-end", status: "completed" });

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

  test("second run's step-end does not update first run's step", () => {
    const store = createFreshStore("cross-run-step");

    // Run 1
    store.getState().append({ type: "run-start" });
    store.getState().append({ type: "user-message", content: "first" });
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "first response" });
    store.getState().append({ type: "text-end" });
    store.getState().append({ type: "step-end", step: 0, finishReason: "stop" });
    store.getState().append({ type: "run-end", status: "completed" });

    // Run 2 with same step number
    store.getState().append({ type: "run-start" });
    store.getState().append({ type: "user-message", content: "second" });
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "step-end", step: 0, finishReason: "stop" });
    store.getState().append({ type: "run-end", status: "completed" });

    const run2Steps = store.getState().steps;
    // Both runs' step 0 should still have their original data
    expect(run2Steps.length).toBe(2);
    expect(run2Steps[0]!.runId).not.toBe(run2Steps[1]!.runId);
  });

  test("partial text preserved when stream errors after text-delta", () => {
    const store = createFreshStore("stream-error-text");
    store.getState().append({ type: "run-start" });
    store.getState().append({ type: "user-message", content: "prompt" });
    store.getState().append({ type: "step-start", step: 0 });

    // Start text streaming, then simulate error (run-end handles cleanup)
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "partial" });

    // consumeFullStream's finally block would flush text-end,
    // then loop-error records the failure, then run-end settles incomplete state
    store.getState().append({ type: "text-end" }); // flushed by try/finally
    store.getState().append({ type: "loop-error", step: 0, error: "stream failed" });
    store.getState().append({ type: "run-end", status: "failed" });

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
    store.getState().append({ type: "run-start" });
    store.getState().append({ type: "user-message", content: "prompt" });
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

  test("failed run settles pending/running tools as error", () => {
    const store = createFreshStore("failed-run-tools");
    store.getState().append({ type: "run-start" });
    store.getState().append({ type: "user-message", content: "use tool" });
    store.getState().append({ type: "step-start", step: 0 });

    store.getState().append({ type: "tool-input-start", toolCallId: "tc-1", toolName: "bash" });
    store.getState().append({ type: "tool-call", toolCallId: "tc-1", toolName: "bash", input: "ls" });

    // Run ends before tool-result arrives
    store.getState().append({ type: "loop-error", step: 0, error: "model crashed" });
    store.getState().append({ type: "run-end", status: "failed" });

    const assistantMsg = store.getState().messages.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const toolParts = assistantMsg!.parts.filter(p => p.type === "tool");
    expect(toolParts.length).toBe(1);
    expect(toolParts[0]!.state).toBe("error");
    if (toolParts[0]!.type === "tool" && toolParts[0]!.state === "error") {
      expect(toolParts[0]!.errorMessage).toBe("Run ended before tool result");
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
    store.getState().append({ type: "user-message", content: "old question" });
    store.getState().append({ type: "run-start" });
    store.getState().append({ type: "user-message", content: "new question" });

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
    store.getState().append({ type: "user-message", content: "message 1" });
    store.getState().append({ type: "user-message", content: "message 2" });

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
    store.getState().append({ type: "user-message", content: "very old" });
    store.getState().append({ type: "user-message", content: "old" });
    store.getState().append({ type: "user-message", content: "recent" });

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
    store.getState().append({ type: "user-message", content: "old" });
    store.getState().append({ type: "user-message", content: "new" });

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
