import { describe, expect, test } from "bun:test";
import type { Reminder, SessionStoreState, StoredMessage, StoredPart } from "../../store/types";
import {
  checkStagnation,
  computeTodoHash,
  hasPendingQuestion,
  isLoopEndAllowed,
  shouldInjectContinuationReminder,
  TODO_CONTINUATION_COOLDOWN_MS,
} from "./todo-continuation";

describe("computeTodoHash", () => {
  test("hashes only todo id and status pairs", () => {
    const baseHash = computeTodoHash([
      { id: "todo-1", content: "first", status: "pending", createdAt: 1, updatedAt: 1 },
      { id: "todo-2", content: "second", status: "completed" },
    ]);

    const contentChangedHash = computeTodoHash([
      { id: "todo-1", content: "renamed", status: "pending", createdAt: 9, updatedAt: 9 },
      { id: "todo-2", content: "also renamed", status: "completed" },
    ]);
    const statusChangedHash = computeTodoHash([
      { id: "todo-1", content: "first", status: "in_progress" },
      { id: "todo-2", content: "second", status: "completed" },
    ]);

    expect(contentChangedHash).toBe(baseHash);
    expect(statusChangedHash).not.toBe(baseHash);
  });
});

describe("checkStagnation", () => {
  test("resets count when the hash changes", () => {
    expect(checkStagnation("new", "old", 2)).toEqual({
      isStagnant: false,
      newCount: 0,
      newHash: "new",
    });
  });

  test("count 2 is not stagnant and count 3 is stagnant", () => {
    expect(checkStagnation("same", "same", 1)).toEqual({
      isStagnant: false,
      newCount: 2,
      newHash: "same",
    });
    expect(checkStagnation("same", "same", 2)).toEqual({
      isStagnant: true,
      newCount: 3,
      newHash: "same",
    });
  });
});

describe("shouldInjectContinuationReminder", () => {
  test("blocks empty and all-completed todo lists", () => {
    expect(shouldInjectContinuationReminder(stateWith({ todos: [] }), 10_000, 0, undefined, { stagnationCount: 3 })).toEqual({
      should: false,
      reason: "no_pending_todos",
    });
    expect(
      shouldInjectContinuationReminder(
        stateWith({ todos: [{ id: "done", content: "done", status: "completed" }] }),
        10_000,
        0,
        undefined,
        { stagnationCount: 3 },
      ),
    ).toEqual({ should: false, reason: "no_pending_todos" });
  });

  test("blocks step-level trigger before stagnation count reaches 3", () => {
    expect(
      shouldInjectContinuationReminder(stateWithPendingTodo(), 10_000, 0, undefined, {
        trigger: "stagnation",
        stagnationCount: 2,
      }),
    ).toEqual({ should: false, reason: "not_stagnant" });
  });

  test("allows step-level trigger at stagnation count 3", () => {
    const result = shouldInjectContinuationReminder(stateWithPendingTodo(), 10_000, 0, undefined, {
      trigger: "stagnation",
      stagnationCount: 3,
    });

    expect(result.should).toBe(true);
    if (!result.should) throw new Error("Expected continuation to be allowed");
    expect(result.reason).toBe("stagnation");
    expect(result.pendingTodos).toEqual([{ id: "todo-1", content: "continue", status: "pending" }]);
    expect(result.reminder).toMatchObject({
      source: { type: "todo_continuation", pendingTodos: result.pendingTodos },
      delivery: "auto_inject",
      createdAt: 10_000,
      consumedAt: null,
    });
    expect(result.reminder.id).toBeString();
    expect(result.reminder.content).toContain("[TODO CONTINUATION]");
    expect(result.reminder.content).toContain("continue");
  });

  test("loop-end trigger skips stagnation threshold", () => {
    const result = shouldInjectContinuationReminder(stateWithPendingTodo(), 10_000, 0, undefined, {
      trigger: "loop_end",
    });

    expect(result.should).toBe(true);
    if (!result.should) throw new Error("Expected continuation to be allowed");
    expect(result.reason).toBe("loop_end");
  });

  test("30s cooldown prevents duplicate continuation", () => {
    const state = stateWith({
      todos: [{ id: "todo-1", content: "continue", status: "pending" }],
      reminders: [todoReminder(1_000)],
    });

    expect(
      shouldInjectContinuationReminder(
        state,
        1_000 + TODO_CONTINUATION_COOLDOWN_MS - 1,
        0,
        undefined,
        { stagnationCount: 3 },
      ),
    ).toEqual({ should: false, reason: "cooldown" });
  });

  test("allows continuation at the cooldown boundary", () => {
    const state = stateWith({
      todos: [{ id: "todo-1", content: "continue", status: "pending" }],
      reminders: [todoReminder(1_000)],
    });

    const result = shouldInjectContinuationReminder(
      state,
      1_000 + TODO_CONTINUATION_COOLDOWN_MS,
      0,
      undefined,
      { stagnationCount: 3 },
    );

    expect(result.should).toBe(true);
  });

  test("pending ask_user tool call blocks continuation", () => {
    const state = stateWith({
      todos: [{ id: "todo-1", content: "continue", status: "pending" }],
      messages: [assistantMessage([toolPart("ask_user")])],
    });

    expect(shouldInjectContinuationReminder(state, 10_000, 0, undefined, { stagnationCount: 3 })).toEqual({
      should: false,
      reason: "pending_question",
    });
  });

  test("running sub-agents block continuation", () => {
    expect(
      shouldInjectContinuationReminder(stateWithPendingTodo(), 10_000, 0, { activeCount: 1 }, { stagnationCount: 3 }),
    ).toEqual({ should: false, reason: "running_sub_agents" });
  });

  test("continuation count 10 blocks continuation", () => {
    expect(
      shouldInjectContinuationReminder(stateWithPendingTodo(), 10_000, 10, undefined, { stagnationCount: 3 }),
    ).toEqual({ should: false, reason: "max_continuations" });
  });
});

describe("isLoopEndAllowed", () => {
  test("allows only completed and max_steps", () => {
    expect(isLoopEndAllowed("completed")).toBe(true);
    expect(isLoopEndAllowed("max_steps")).toBe(true);
    expect(isLoopEndAllowed("failed")).toBe(false);
    expect(isLoopEndAllowed("aborted")).toBe(false);
    expect(isLoopEndAllowed("cancelled")).toBe(false);
    expect(isLoopEndAllowed("timed_out")).toBe(false);
  });
});

describe("hasPendingQuestion", () => {
  test("scans only the last assistant message for ask_user tool calls", () => {
    const state = stateWith({
      messages: [
        assistantMessage([toolPart("ask_user")], "assistant-old"),
        userMessage("user-later"),
        assistantMessage([toolPart("file_read")], "assistant-new"),
      ],
    });

    expect(hasPendingQuestion(state)).toBe(false);
  });

  test("returns true when last assistant message has ask_user tool call", () => {
    const state = stateWith({ messages: [assistantMessage([toolPart("ask_user")])] });

    expect(hasPendingQuestion(state)).toBe(true);
  });
});

function stateWithPendingTodo(): SessionStoreState {
  return stateWith({ todos: [{ id: "todo-1", content: "continue", status: "pending" }] });
}

function stateWith(overrides: Partial<SessionStoreState>): SessionStoreState {
  return {
    sessionId: "session-1",
    createdAt: 1,
    title: null,
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionIds: new Set(),
    subAgentDescriptions: new Map(),
    isRunning: false,
    isStreamingModel: false,
    streamingTools: {},
    readSnapshots: new Map(),
    runCount: 0,
    append: () => {},
    toModelMessages: () => [],
    ...overrides,
  };
}

function todoReminder(createdAt: number): Reminder {
  return {
    id: `reminder-${createdAt}`,
    source: { type: "todo_continuation", pendingTodos: [] },
    delivery: "auto_inject",
    content: "continue",
    createdAt,
    consumedAt: null,
  };
}

function assistantMessage(parts: StoredPart[], id = "assistant-1"): StoredMessage {
  return { id, role: "assistant", parts, createdAt: 1 };
}

function userMessage(id: string): StoredMessage {
  return { id, role: "user", parts: [], createdAt: 1 };
}

function toolPart(toolName: string): StoredPart {
  return {
    type: "tool",
    state: "pending",
    id: `part-${toolName}`,
    toolCallId: `call-${toolName}`,
    toolName,
    createdAt: 1,
  };
}
