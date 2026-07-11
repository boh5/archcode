import { describe, expect, test } from "bun:test";
import type { SessionTodo } from "@archcode/protocol";
import { deriveTodoProgress, presentTodoContent } from "./todo-progress";

const todos: SessionTodo[] = [
  { id: "one", content: "Done", status: "completed" },
  { id: "two", content: "Current", status: "in_progress" },
  { id: "three", content: "Next", status: "pending" },
];

describe("deriveTodoProgress", () => {
  test("returns no presentation for an empty todo list", () => {
    expect(deriveTodoProgress([], { isRunning: false })).toBeNull();
  });

  test("reports counts and running state from live execution data", () => {
    expect(deriveTodoProgress(todos, { isRunning: true })).toEqual({
      total: 3,
      completed: 1,
      current: 1,
      upcoming: 1,
      percent: 33,
      state: "running",
    });
  });

  test("distinguishes waiting, blocked, failed, and completed states", () => {
    expect(deriveTodoProgress(todos, { isRunning: false, lastExecutionStatus: "waiting_for_human" })?.state).toBe("waiting");
    expect(deriveTodoProgress(todos, { isRunning: false, blockedByHitlIds: ["hitl-1"] })?.state).toBe("blocked");
    expect(deriveTodoProgress(todos, { isRunning: false, lastExecutionStatus: "failed" })?.state).toBe("failed");
    expect(deriveTodoProgress(todos.map((todo) => ({ ...todo, status: "completed" })), { isRunning: false })?.state).toBe("completed");
  });
});

describe("presentTodoContent", () => {
  test("extracts P0, P1, and P2 priorities without leaking the tag into task text", () => {
    expect(presentTodoContent("P0 Fix production")).toEqual({ content: "Fix production", priority: "high" });
    expect(presentTodoContent("Review P1 regression")).toEqual({ content: "Review regression", priority: "medium" });
    expect(presentTodoContent("Polish UI P2")).toEqual({ content: "Polish UI", priority: "low" });
  });

  test("preserves unprioritized Todo text", () => {
    expect(presentTodoContent("Run tests")).toEqual({ content: "Run tests", priority: null });
  });
});
