import { describe, expect, test } from "bun:test";
import { reduceStreamEvent } from "./reduce";
import type { ReduceContext } from "./reduce";
import type {
  Reminder,
  SessionMessage,
  SessionPart,
  SessionProjection,
  SessionStep,
  SessionTodo,
  StreamEvent,
} from "./types";

function createProjection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    sessionId: "session-test",
    title: null,
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    runCount: 0,
    isRunning: false,
    isStreamingModel: false,
    ...overrides,
  };
}

function applyEvents(state: SessionProjection, events: StreamEvent[]): SessionProjection {
  const ctx = createDeterministicContext();

  return events.reduce(
    (current, event) => ({ ...current, ...reduceStreamEvent(current, event, ctx) }),
    state,
  );
}

function createDeterministicContext(): ReduceContext {
  let nextId = 0;

  return {
    timestamp: 123456789,
    generateId: () => `id-${nextId++}`,
  };
}

function onlyMessage(messages: SessionMessage[]): SessionMessage {
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

function partOfType<T extends SessionPart["type"]>(
  message: SessionMessage,
  type: T,
  index = 0,
): Extract<SessionPart, { type: T }> {
  const matches = message.parts.filter(
    (part): part is Extract<SessionPart, { type: T }> => part.type === type,
  );
  expect(matches.length).toBeGreaterThan(index);
  return matches[index]!;
}

function onlyStep(steps: SessionStep[]): SessionStep {
  expect(steps).toHaveLength(1);
  return steps[0]!;
}

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "reminder-1",
    source: { type: "todo_step_reminder", pendingTodos: [] },
    delivery: "auto_inject",
    content: "remember",
    createdAt: Date.now(),
    consumedAt: 123,
    ...overrides,
  };
}

describe("reduceStreamEvent", () => {
  test("accumulates text deltas between start and end", () => {
    const state = applyEvents(createProjection(), [
      { type: "text-start" },
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "text-end" },
    ]);

    const text = partOfType(onlyMessage(state.messages), "text");
    expect(text.text).toBe("hello");
    expect(text.completedAt).toBeGreaterThan(0);
    expect(state.currentAssistantMessageId).toBe(state.messages[0]!.id);
  });

  test("produces identical projections with the same events and deterministic context", () => {
    const events: StreamEvent[] = [
      { type: "run-start" },
      { type: "user-message", content: "hello" },
      { type: "step-start", step: 0 },
      { type: "text-start" },
      { type: "text-delta", text: "hi" },
      { type: "text-end" },
      { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a.ts" } },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read",
        output: "content",
        isError: false,
      },
      { type: "step-end", step: 0, finishReason: "stop" },
      { type: "run-end", status: "completed" },
    ];

    const first = applyEvents(createProjection(), events);
    const second = applyEvents(createProjection(), events);

    expect(first).toEqual(second);
  });

  test("accumulates reasoning deltas between start and end", () => {
    const state = applyEvents(createProjection(), [
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "think" },
      { type: "reasoning-delta", text: "ing" },
      { type: "reasoning-end" },
    ]);

    const reasoning = partOfType(onlyMessage(state.messages), "reasoning");
    expect(reasoning.text).toBe("thinking");
    expect(reasoning.completedAt).toBeGreaterThan(0);
  });

  test("transitions tool call lifecycle from pending to running to completed", () => {
    const input = { path: "file.ts" };
    const state = applyEvents(createProjection(), [
      { type: "tool-input-start", toolCallId: "call-1", toolName: "read" },
      { type: "tool-call", toolCallId: "call-1", toolName: "read", input },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read",
        output: "content",
        isError: false,
        meta: { exitCode: 0 },
      },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    expect(tool.state).toBe("completed");
    if (tool.state !== "completed") throw new Error("Expected completed tool");
    expect(tool.input).toBe(input);
    expect(tool.output).toBe("content");
    expect(tool.meta).toEqual({ exitCode: 0 });
  });

  test("preserves nested diff metadata on completed tool parts", () => {
    const diffs = {
      version: 1,
      files: [
        {
          path: "src/index.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          hunks: [],
        },
      ],
    };
    const state = applyEvents(createProjection(), [
      { type: "tool-call", toolCallId: "call-1", toolName: "file_edit", input: { filePath: "src/index.ts" } },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "file_edit",
        output: "updated",
        isError: false,
        meta: { diffs },
      },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    expect(tool.state).toBe("completed");
    if (tool.state !== "completed") throw new Error("Expected completed tool");
    expect(tool.meta?.diffs).toBe(diffs);
  });

  test("transitions tool call lifecycle from pending to running to error", () => {
    const state = applyEvents(createProjection(), [
      { type: "tool-input-start", toolCallId: "call-1", toolName: "bash" },
      { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: "bad" },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "bash",
        output: "failed",
        isError: true,
      },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    expect(tool.state).toBe("error");
    if (tool.state !== "error") throw new Error("Expected error tool");
    expect(tool.errorMessage).toBe("failed");
    expect(tool.endedAt).toBeGreaterThan(0);
  });

  test("replaces todos when todo-write contains valid todos", () => {
    const todos: SessionTodo[] = [
      { id: "todo-1", content: "first", status: "pending" },
      { id: "todo-2", content: "second", status: "in_progress" },
    ];

    const state = applyEvents(createProjection(), [{ type: "todo-write", todos }]);

    expect(state.todos).toEqual(todos);
    expect(state.todos).not.toBe(todos);
  });

  test("ignores todo-write with multiple in_progress todos without throwing", () => {
    const previousTodos: SessionTodo[] = [{ id: "keep", content: "keep", status: "completed" }];
    const state = createProjection({ todos: previousTodos });

    expect(() =>
      reduceStreamEvent(
        state,
        {
          type: "todo-write",
          todos: [
            { id: "one", content: "one", status: "in_progress" },
            { id: "two", content: "two", status: "in_progress" },
          ],
        },
        createDeterministicContext(),
      ),
    ).not.toThrow();

    const patch = reduceStreamEvent(
      state,
      {
        type: "todo-write",
        todos: [
          { id: "one", content: "one", status: "in_progress" },
          { id: "two", content: "two", status: "in_progress" },
        ],
      },
      createDeterministicContext(),
    );
    expect(patch).toEqual({});
  });

  test("tracks step start and end", () => {
    const usage = { inputTokens: 1, outputTokens: 2 };
    const state = applyEvents(createProjection({ currentRunId: "run-1" }), [
      { type: "step-start", step: 0 },
      { type: "step-end", step: 0, finishReason: "stop", usage },
    ]);

    const step = onlyStep(state.steps);
    expect(state.isStreamingModel).toBe(false);
    expect(step.step).toBe(0);
    expect(step.runId).toBe("run-1");
    expect(step.finishReason).toBe("stop");
    expect(step.usage).toBe(usage);
    expect(step.completedAt).toBeGreaterThan(0);
  });

  test("handles compaction events", () => {
    const first: SessionMessage = {
      id: "first",
      role: "user",
      parts: [{ type: "text", id: "p1", text: "first", createdAt: 1, completedAt: 1 }],
      createdAt: 1,
      completedAt: 1,
    };
    const tail: SessionMessage = {
      id: "tail",
      role: "assistant",
      parts: [{ type: "text", id: "p2", text: "tail", createdAt: 2, completedAt: 2 }],
      createdAt: 2,
      completedAt: 2,
    };

    const state = applyEvents(createProjection({ messages: [first, tail] }), [
      { type: "compact", summary: "summary", tailStartId: "tail" },
    ]);

    expect(state.messages[0]!.compacted).toBe(true);
    expect(state.messages).toHaveLength(3);
    const compaction = state.messages[1]!;
    expect(compaction.role).toBe("user");
    expect(partOfType(compaction, "compaction").summary).toBe("summary");
    expect(state.messages[2]!.id).toBe("tail");
  });

  test("creates system notice messages", () => {
    const state = applyEvents(createProjection({ currentRunId: "run-system" }), [
      { type: "system-notice", message: "notice" },
    ]);

    const message = onlyMessage(state.messages);
    expect(message.role).toBe("user");
    expect(message.runId).toBe("run-system");
    expect(partOfType(message, "system-notice").notice).toBe("notice");
  });

  test("tracks run start and end without busy errors", () => {
    const afterStart = applyEvents(createProjection({ isRunning: true, runCount: 1 }), [
      { type: "run-start", runId: "run-2" },
    ]);

    expect(afterStart.isRunning).toBe(true);
    expect(afterStart.currentRunId).toBe("run-2");
    expect(afterStart.runCount).toBe(2);

    const afterEnd = applyEvents(afterStart, [{ type: "run-end", status: "completed" }]);
    expect(afterEnd.isRunning).toBe(false);
    expect(afterEnd.isStreamingModel).toBe(false);
    expect(afterEnd.currentRunId).toBeUndefined();
    expect(afterEnd.currentAssistantMessageId).toBeUndefined();
  });

  test("adds and consumes reminders", () => {
    const reminder = makeReminder({ id: "reminder-1" });
    const state = applyEvents(createProjection(), [
      { type: "reminder", reminder },
      { type: "reminder-consumed", reminderIds: ["reminder-1"] },
    ]);

    expect(state.reminders).toHaveLength(1);
    expect(state.reminders[0]).toMatchObject({ id: "reminder-1", consumedAt: expect.any(Number) });
  });

  test("creates user messages", () => {
    const state = applyEvents(createProjection({ currentRunId: "run-user" }), [
      { type: "user-message", content: "hello" },
    ]);

    const message = onlyMessage(state.messages);
    expect(message.role).toBe("user");
    expect(message.runId).toBe("run-user");
    expect(message.completedAt).toBeGreaterThan(0);
    expect(partOfType(message, "text").text).toBe("hello");
  });

  test("records loop errors on matching or synthetic steps", () => {
    const matching = applyEvents(createProjection({ currentRunId: "run-error" }), [
      { type: "step-start", step: 1 },
      { type: "loop-error", step: 1, error: "bad loop" },
    ]);
    expect(onlyStep(matching.steps).error).toBe("bad loop");

    const synthetic = applyEvents(createProjection({ currentRunId: "run-error" }), [
      { type: "loop-error", step: 4, error: "missing step" },
    ]);
    const step = onlyStep(synthetic.steps);
    expect(step.step).toBe(4);
    expect(step.runId).toBe("run-error");
    expect(step.error).toBe("missing step");
  });
});
