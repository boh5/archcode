import { describe, expect, test } from "bun:test";
import type { Reminder, ExecutionEndEvent, StreamEvent } from "./types";
import { BusyError } from "./types";

describe("BusyError", () => {
  test("has correct name property", () => {
    const error = new BusyError("test-session");
    expect(error.name).toBe("BusyError");
  });

  test("includes session id in message", () => {
    const error = new BusyError("my-session-42");
    expect(error.message).toContain("my-session-42");
    expect(error.message).toContain("running");
  });

  test("is instance of Error", () => {
    const error = new BusyError("test-session");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("Reminder", () => {
  test("creates valid reminder objects with all fields", () => {
    const reminder: Reminder = {
      id: "reminder-1",
      source: {
        type: "todo_step_reminder",
        pendingTodos: [
          {
            id: "todo-1",
            content: "Continue implementation",
            status: "pending",
            createdAt: 100,
            updatedAt: 200,
          },
        ],
      },
      delivery: "auto_inject",
      sessionId: "session-1",
      terminalState: "completed",
      content: "Pending todo reminder",
      payload: { pendingCount: 1 },
      createdAt: 300,
      consumedAt: null,
      targetSessionId: "target-session-1",
    };

    expect(reminder.id).toBe("reminder-1");
    expect(reminder.source.type).toBe("todo_step_reminder");
    expect(reminder.consumedAt).toBeNull();
  });

  test("creates subagent reminder sources", () => {
    const reminders: Reminder[] = [
      {
        id: "completed",
        source: { type: "subagent_completed", sessionId: "child-1" },
        delivery: "on_demand",
        content: "Subagent completed",
        createdAt: 1,
        consumedAt: null,
      },
      {
        id: "failed",
        source: { type: "subagent_failed", sessionId: "child-2" },
        delivery: "on_demand",
        content: "Subagent failed",
        createdAt: 2,
        consumedAt: null,
      },
      {
        id: "timed-out",
        source: { type: "subagent_timed_out", sessionId: "child-3" },
        delivery: "on_demand",
        content: "Subagent timed out",
        createdAt: 3,
        consumedAt: null,
      },
      {
        id: "cancelled",
        source: { type: "subagent_cancelled", sessionId: "child-4" },
        delivery: "on_demand",
        content: "Subagent cancelled",
        createdAt: 4,
        consumedAt: null,
      },
    ];

    expect(reminders.map((reminder) => reminder.source.type)).toEqual([
      "subagent_completed",
      "subagent_failed",
      "subagent_timed_out",
      "subagent_cancelled",
    ]);
  });
});

describe("StreamEvent", () => {
  test("recognizes reminder event types", () => {
    const reminder: Reminder = {
      id: "reminder-1",
      source: { type: "subagent_completed", sessionId: "child-1" },
      delivery: "auto_inject",
      content: "Child session completed",
      createdAt: 100,
      consumedAt: null,
    };

    const events: StreamEvent[] = [
      { type: "reminder", reminder },
      { type: "reminder-consumed", reminderIds: ["reminder-1"] },
    ];

    expect(events[0]?.type).toBe("reminder");
    expect(events[1]?.type).toBe("reminder-consumed");
  });
});

describe("ExecutionEndEvent", () => {
  test("accepts all terminal status values", () => {
    const statuses: ExecutionEndEvent["status"][] = [
      "completed",
      "max_steps",
      "failed",
      "aborted",
      "cancelled",
      "timed_out",
    ];

    const events: ExecutionEndEvent[] = statuses.map((status) => ({
      type: "execution-end",
      status,
    }));

    expect(events.map((event) => event.status)).toEqual(statuses);
  });
});
