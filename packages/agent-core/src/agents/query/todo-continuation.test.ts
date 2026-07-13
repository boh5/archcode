import { describe, expect, test } from "bun:test";
import { createEmptySessionStats } from "@archcode/protocol";
import type { Reminder, SessionStoreState, StoredMessage, StoredPart } from "../../store/types";
import { createEmptyCompressionState } from "../../compression";
import {
  getStepsSinceLastTodoWrite,
  getStepsSinceLastReminder,
  hasPendingQuestion,
  isLoopEndAllowed,
  shouldInjectReminder,
  shouldContinueAfterLoop,
  TODO_REMINDER_COOLDOWN_MS,
  TODO_CONTINUATION_COOLDOWN_MS,
} from "./todo-continuation";

describe("getStepsSinceLastTodoWrite", () => {
  test("returns 0 when no steps exist", () => {
    expect(getStepsSinceLastTodoWrite(stateWith({ steps: [], lastTodoWriteStepIndex: null }))).toBe(0);
  });

  test("returns stepCount + 1 when no todo_write has occurred", () => {
    const state = stateWith({
      steps: [{ id: "s0", step: 0, startedAt: 1 }, { id: "s1", step: 1, startedAt: 2 }],
      lastTodoWriteStepIndex: null,
    });
    expect(getStepsSinceLastTodoWrite(state)).toBe(2);
  });

  test("counts steps since last todo_write", () => {
    const state = stateWith({
      steps: [{ id: "s0", step: 0, startedAt: 1 }, { id: "s1", step: 1, startedAt: 2 }, { id: "s2", step: 2, startedAt: 3 }],
      lastTodoWriteStepIndex: 0,
    });
    expect(getStepsSinceLastTodoWrite(state)).toBe(2);
  });
});

describe("getStepsSinceLastReminder", () => {
  test("returns STEP_INTERVAL when no steps exist", () => {
    expect(getStepsSinceLastReminder(stateWith({ steps: [], lastTodoReminderStepIndex: null }))).toBe(10);
  });

  test("counts steps since last reminder", () => {
    const state = stateWith({
      steps: [{ id: "s0", step: 0, startedAt: 1 }, { id: "s1", step: 1, startedAt: 2 }, { id: "s2", step: 2, startedAt: 3 }],
      lastTodoReminderStepIndex: 1,
    });
    expect(getStepsSinceLastReminder(state)).toBe(1);
  });
});

describe("shouldInjectReminder", () => {
  test("blocks empty and all-completed todo lists", () => {
    expect(shouldInjectReminder(stateWith({ todos: [] }), 10_000)).toEqual({
      should: false,
      reason: "no_pending_todos",
    });
    expect(
      shouldInjectReminder(
        stateWith({ todos: [{ id: "done", content: "done", status: "completed" }] }),
        10_000,
      ),
    ).toEqual({ should: false, reason: "no_pending_todos" });
  });

  test("blocks when steps since last todo_write below threshold", () => {
    const state = stateWithPendingTodo({ lastTodoWriteStepIndex: 8, steps: stepsForCount(9) });
    expect(shouldInjectReminder(state, 10_000)).toEqual({
      should: false,
      reason: "steps_since_write_below_threshold",
    });
  });

  test("allows reminder when 10 steps since last todo_write", () => {
    const state = stateWithPendingTodo({ lastTodoWriteStepIndex: null, steps: stepsForCount(10) });

    const result = shouldInjectReminder(state, 10_000);

    expect(result.should).toBe(true);
    if (!result.should) throw new Error("Expected reminder to be allowed");
    expect(result.pendingTodos).toEqual([{ id: "todo-1", content: "continue", status: "pending" }]);
    expect(result.reminder).toMatchObject({
      source: { type: "todo_step_reminder", pendingTodos: result.pendingTodos },
      delivery: "auto_inject",
      createdAt: 10_000,
      consumedAt: null,
    });
    expect(result.reminder.id).toBeString();
    expect(result.reminder.content).toContain("TODO REMINDER");
    expect(result.reminder.content).toContain("Consider using the");
  });

  test("30s cooldown prevents duplicate reminder", () => {
    const state = stateWith({
      todos: [{ id: "todo-1", content: "continue", status: "pending" }],
      reminders: [todoReminder(1_000)],
      lastTodoWriteStepIndex: null,
      steps: stepsForCount(10),
    });

    expect(
      shouldInjectReminder(state, 1_000 + TODO_REMINDER_COOLDOWN_MS - 1),
    ).toEqual({ should: false, reason: "cooldown" });
  });

  test("allows reminder at the cooldown boundary", () => {
    const state = stateWith({
      todos: [{ id: "todo-1", content: "continue", status: "pending" }],
      reminders: [todoReminder(1_000)],
      lastTodoWriteStepIndex: null,
      steps: stepsForCount(10),
    });

    const result = shouldInjectReminder(state, 1_000 + TODO_REMINDER_COOLDOWN_MS);
    expect(result.should).toBe(true);
  });

  test("pending ask_user tool call blocks reminder", () => {
    const state = stateWith({
      todos: [{ id: "todo-1", content: "continue", status: "pending" }],
      messages: [assistantMessage([toolPart("ask_user")])],
      lastTodoWriteStepIndex: 0,
      steps: stepsForCount(11),
    });

    expect(shouldInjectReminder(state, 10_000)).toEqual({
      should: false,
      reason: "pending_question",
    });
  });

  test("todo continuation count 10 blocks reminder", () => {
    const state = stateWithPendingTodo({
      lastTodoWriteStepIndex: 0,
      steps: stepsForCount(11),
      todoStepReminderCount: 10,
    });
    expect(shouldInjectReminder(state, 10_000)).toEqual({
      should: false,
      reason: "max_reminders",
    });
  });
});

describe("shouldContinueAfterLoop", () => {
  test("disallowed status blocks continuation", () => {
    const state = stateWithPendingTodo();
    expect(shouldContinueAfterLoop(state, "failed", 10_000)).toEqual({
      should: false,
      reason: "disallowed_status",
    });
    expect(shouldContinueAfterLoop(state, "aborted", 10_000)).toEqual({
      should: false,
      reason: "disallowed_status",
    });
  });

  test("no pending todos blocks continuation", () => {
    expect(shouldContinueAfterLoop(stateWith({ todos: [] }), "completed", 10_000)).toEqual({
      should: false,
      reason: "no_pending_todos",
    });
  });

  test("allows continuation on completed loop with pending todos", () => {
    const state = stateWithPendingTodo();
    const result = shouldContinueAfterLoop(state, "completed", 10_000);

    expect(result.should).toBe(true);
    if (!result.should) throw new Error("Expected continuation");
    expect(result.reminder.content).toContain("TODO CONTINUATION");
    expect(result.reminder.content).toContain("Please continue working");
  });

  test("60s cooldown blocks continuation", () => {
    const state = stateWith({
      todos: [{ id: "todo-1", content: "continue", status: "pending" }],
      reminders: [loopContinuationReminder(1_000)],
    });

    expect(shouldContinueAfterLoop(state, "completed", 1_000 + TODO_CONTINUATION_COOLDOWN_MS - 1)).toEqual({
      should: false,
      reason: "cooldown",
    });
  });

  test("pending question blocks continuation", () => {
    const state = stateWith({
      todos: [{ id: "todo-1", content: "continue", status: "pending" }],
      messages: [assistantMessage([toolPart("ask_user")])],
    });

    expect(shouldContinueAfterLoop(state, "completed", 10_000)).toEqual({
      should: false,
      reason: "pending_question",
    });
  });

  test("max continuation count 5 blocks continuation", () => {
    const state = stateWithPendingTodo({ todoLoopContinuationCount: 5 });
    expect(shouldContinueAfterLoop(state, "completed", 10_000)).toEqual({
      should: false,
      reason: "max_continuations",
    });
  });

  test("stagnation blocks continuation after 3 no-progress continuations", () => {
    const state = stateWithPendingTodo({
      todoContinuationStagnationCount: 2,
      lastTodoContinuationPendingCount: 1,
    });
    expect(shouldContinueAfterLoop(state, "completed", 10_000)).toEqual({
      should: false,
      reason: "stagnation",
    });
  });

  test("stagnation resets when pending count decreases", () => {
    const state = stateWith({
      todos: [{ id: "todo-1", content: "done", status: "completed" }, { id: "todo-2", content: "continue", status: "pending" }],
      todoContinuationStagnationCount: 2,
      lastTodoContinuationPendingCount: 3,
    });
    const result = shouldContinueAfterLoop(state, "completed", 10_000);
    expect(result.should).toBe(true);
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

function stateWithPendingTodo(overrides: Partial<SessionStoreState> = {}): SessionStoreState {
  return stateWith({ todos: [{ id: "todo-1", content: "continue", status: "pending" }], ...overrides });
}

function stepsForCount(count: number): SessionStoreState["steps"] {
  return Array.from({ length: count }, (_, i) => ({
    id: `step-${i}`,
    step: i,
    startedAt: i,
  }));
}

function stateWith(overrides: Partial<SessionStoreState>): SessionStoreState {
  return { sessionId: "session-1",
  rootSessionId: "session-1",
  createdAt: 1,
  cwd: "/workspace",
  agentName: "engineer",
  title: null,
  messages: [],
  steps: [],
  stats: createEmptySessionStats(),
  executions: [],
  todos: [],
  reminders: [],
  childSessionLinks: [],
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
  append: () => {},
  setCwd: () => {},
  setTitle: () => {},
  setParentSessionId: () => {},
  setGoalId: () => {},
  setSessionRole: () => {},
  toModelMessages: () => [],
  ...overrides,
  updatedAt: overrides.updatedAt ?? 1,
  modelInfo: overrides.modelInfo ?? null,
  compression: overrides.compression ?? createEmptyCompressionState(),
  };
}

function todoReminder(createdAt: number): Reminder {
  return {
    id: `reminder-${createdAt}`,
    source: { type: "todo_step_reminder", pendingTodos: [] },
    delivery: "auto_inject",
    content: "reminder",
    createdAt,
    consumedAt: null,
  };
}

function loopContinuationReminder(createdAt: number): Reminder {
  return {
    id: `reminder-${createdAt}`,
    source: { type: "todo_loop_continuation", pendingTodos: [] },
    delivery: "auto_inject",
    content: "continuation",
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
