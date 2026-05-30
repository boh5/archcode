import { describe, expect, test } from "bun:test";
import { reduceStreamEvent } from "./reduce";
import type { ReduceContext } from "./reduce";
import { createEmptySessionStats } from "./usage";
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
    stats: createEmptySessionStats(),
    runs: [],
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
  test("defaults stats to all zeros and runs to empty for never-run sessions", () => {
    const state = createProjection();

    expect(state.stats).toEqual(createEmptySessionStats());
    expect(state.stats.tools.calls).toBe(0);
    expect(state.stats.tools.completed).toBe(0);
    expect(state.stats.tools.failed).toBe(0);
    expect(state.runs).toEqual([]);
    expect(state.runCount).toBe(state.runs.length);
  });

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
    expect(state.stats.messages).toEqual({ user: 0, assistant: 1, total: 1 });
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
    expect(state.stats.tools).toEqual({ calls: 1, completed: 1, failed: 0 });
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
    expect(state.stats.tools).toEqual({ calls: 1, completed: 0, failed: 1 });
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
    expect(state.stats.steps).toEqual({ started: 1, completed: 1 });
    expect(state.stats.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    });
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

  test("stats remain unchanged after a compact event", () => {
    const before = applyEvents(createProjection(), [
      { type: "user-message", content: "hello" },
      { type: "text-start" },
      { type: "text-delta", text: "hi" },
      { type: "text-end" },
    ]);

    const after = applyEvents(before, [{ type: "compact", summary: "summary", tailStartId: "missing" }]);

    expect(after.stats).toEqual(before.stats);
  });

  test("creates system notice messages", () => {
    const state = applyEvents(createProjection({ currentRunId: "run-system" }), [
      { type: "system-notice", message: "notice" },
    ]);

    const message = onlyMessage(state.messages);
    expect(message.role).toBe("user");
    expect(message.runId).toBe("run-system");
    expect(partOfType(message, "system-notice").notice).toBe("notice");
    expect(state.stats.messages).toEqual({ user: 0, assistant: 0, total: 0 });
  });

  test("tracks run start and end without busy errors", () => {
    const afterStart = applyEvents(
      createProjection({
        isRunning: true,
        runs: [{ id: "run-1", startedAt: 1, status: "completed", endedAt: 2, durationMs: 1 }],
        runCount: 1,
      }),
      [{ type: "run-start", runId: "run-2" }],
    );

    expect(afterStart.isRunning).toBe(true);
    expect(afterStart.currentRunId).toBe("run-2");
    expect(afterStart.runCount).toBe(2);
    expect(afterStart.runCount).toBe(afterStart.runs.length);

    const afterEnd = applyEvents(afterStart, [{ type: "run-end", status: "completed" }]);
    expect(afterEnd.isRunning).toBe(false);
    expect(afterEnd.isStreamingModel).toBe(false);
    expect(afterEnd.currentRunId).toBeUndefined();
    expect(afterEnd.currentAssistantMessageId).toBeUndefined();
    expect(afterEnd.runs[1]).toMatchObject({ id: "run-2", status: "completed" });
    expect(afterEnd.runCount).toBe(afterEnd.runs.length);
  });

  test("user, assistant, and total message counts update exactly without compaction double-counting", () => {
    const state = applyEvents(createProjection(), [
      { type: "user-message", content: "first" },
      { type: "text-start" },
      { type: "text-delta", text: "reply" },
      { type: "text-end" },
      { type: "compact", summary: "summary", tailStartId: "missing" },
      { type: "text-start" },
      { type: "text-delta", text: "same assistant message" },
    ]);

    expect(state.stats.messages).toEqual({ user: 1, assistant: 1, total: 2 });
  });

  test("N concurrent tool-call events produce N tool call stats", () => {
    const state = applyEvents(createProjection(), [
      { type: "step-start", step: 0 },
      { type: "tool-call", toolCallId: "call-1", toolName: "read", input: {} },
      { type: "tool-call", toolCallId: "call-2", toolName: "read", input: {} },
      { type: "tool-call", toolCallId: "call-3", toolName: "read", input: {} },
    ]);

    expect(state.stats.tools).toEqual({ calls: 3, completed: 0, failed: 0 });
  });

  test("failed tool-result counts as called and failed but not completed", () => {
    const state = applyEvents(createProjection(), [
      { type: "step-start", step: 0 },
      { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: "exit 1" },
      { type: "tool-result", toolCallId: "call-1", toolName: "bash", output: "boom", isError: true },
    ]);

    expect(state.stats.tools).toEqual({ calls: 1, completed: 0, failed: 1 });
  });

  test("tool-input-start followed by duplicate calls and results counts one call and one terminal", () => {
    const state = applyEvents(createProjection(), [
      { type: "tool-input-start", toolCallId: "call-1", toolName: "read" },
      { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a" } },
      { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a" } },
      { type: "tool-result", toolCallId: "call-1", toolName: "read", output: "ok", isError: false },
      { type: "tool-result", toolCallId: "call-1", toolName: "read", output: "ok", isError: false },
    ]);

    expect(state.stats.tools).toEqual({ calls: 1, completed: 1, failed: 0 });
  });

  test("pending and running tools settled by run-end increment failed exactly once for counted calls", () => {
    const state = applyEvents(createProjection(), [
      { type: "run-start", runId: "run-1" },
      { type: "tool-input-start", toolCallId: "pending", toolName: "read" },
      { type: "tool-call", toolCallId: "running", toolName: "read", input: {} },
      { type: "run-end", status: "failed", error: "boom" },
      { type: "run-end", status: "failed" },
    ]);

    expect(state.stats.tools).toEqual({ calls: 1, completed: 0, failed: 1 });
  });

  test("step-end usage provider variants normalize into shared usage stats", () => {
    const state = applyEvents(createProjection({ currentRunId: "run-usage" }), [
      { type: "step-start", step: 0 },
      { type: "step-end", step: 0, finishReason: "stop", usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 6 } },
      { type: "step-start", step: 1 },
      { type: "step-end", step: 1, finishReason: "stop", usage: { input_tokens: 5, output_tokens: 7 } },
      { type: "step-start", step: 2 },
      { type: "step-end", step: 2, finishReason: "stop", usage: { prompt_token_count: 11, candidates_token_count: 13, total_token_count: 29 } },
    ]);

    expect(state.stats.usage).toEqual({
      inputTokens: 18,
      outputTokens: 23,
      totalTokens: 47,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    });
  });

  test("reasoning and cached-token aliases populate normalized usage fields", () => {
    const state = applyEvents(createProjection({ currentRunId: "run-usage" }), [
      { type: "step-start", step: 0 },
      { type: "step-end", step: 0, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cachedInputTokens: 4 } },
      { type: "step-start", step: 1 },
      { type: "step-end", step: 1, finishReason: "stop", usage: { promptTokens: 5, completionTokens: 6, completion_tokens_details: { reasoning_tokens: 7 }, prompt_tokens_details: { cached_tokens: 8 } } },
      { type: "step-start", step: 2 },
      { type: "step-end", step: 2, finishReason: "stop", usage: { input_tokens: 9, output_tokens: 10, output_token_details: { reasoning: 11 }, cache_read_input_tokens: 12 } },
    ]);

    expect(state.stats.usage).toEqual({
      inputTokens: 15,
      outputTokens: 18,
      totalTokens: 33,
      reasoningTokens: 21,
      cachedInputTokens: 24,
    });
  });

  test("system notices and compaction synthetic messages do not increment user message stats", () => {
    const state = applyEvents(createProjection(), [
      { type: "system-notice", message: "notice" },
      { type: "compact", summary: "summary", tailStartId: "missing" },
    ]);

    expect(state.stats.messages.user).toBe(0);
    expect(state.stats.messages.total).toBe(0);
  });

  test("computed run id aligns runs, current run, messages, and steps", () => {
    const state = applyEvents(createProjection(), [
      { type: "run-start" },
      { type: "user-message", content: "hello" },
      { type: "step-start", step: 0 },
    ]);
    const runId = state.runs[0]!.id;

    expect(state.currentRunId).toBe(runId);
    expect(state.messages[0]!.runId).toBe(runId);
    expect(state.steps[0]!.runId).toBe(runId);
  });

  test("run-end without current run does not append a fake run", () => {
    const state = applyEvents(createProjection(), [{ type: "run-end", status: "completed" }]);

    expect(state.runs).toEqual([]);
    expect(state.runCount).toBe(0);
  });

  test("runCount equals runs.length after create, run-start, and run-end", () => {
    const created = createProjection();
    expect(created.runCount).toBe(created.runs.length);

    const started = applyEvents(created, [{ type: "run-start", runId: "run-1" }]);
    expect(started.runCount).toBe(started.runs.length);

    const ended = applyEvents(started, [{ type: "run-end", status: "completed" }]);
    expect(ended.runCount).toBe(ended.runs.length);
  });

  test("cancelled, aborted, and timed_out run-end statuses populate latest run", () => {
    const state = applyEvents(createProjection(), [
      { type: "run-start", runId: "run-cancelled" },
      { type: "run-end", status: "cancelled", error: "cancelled by user" },
      { type: "run-start", runId: "run-aborted" },
      { type: "run-end", status: "aborted", error: "abort signal" },
      { type: "run-start", runId: "run-timed-out" },
      { type: "run-end", status: "timed_out", error: "deadline" },
    ]);

    expect(state.runs.map((run) => run.status)).toEqual(["cancelled", "aborted", "timed_out"]);
    expect(state.runs.at(-1)).toMatchObject({
      id: "run-timed-out",
      status: "timed_out",
      error: "deadline",
    });
    expect(state.runCount).toBe(state.runs.length);
  });

  test("compaction summary updates do not mutate existing stats", () => {
    const before = applyEvents(createProjection(), [
      { type: "user-message", content: "old" },
      { type: "step-start", step: 0 },
      { type: "tool-call", toolCallId: "call-1", toolName: "read", input: {} },
      { type: "tool-result", toolCallId: "call-1", toolName: "read", output: "ok", isError: false },
      { type: "step-end", step: 0, finishReason: "stop", usage: { inputTokens: 3, outputTokens: 4 } },
    ]);
    const stats = before.stats;

    const afterFirstCompact = applyEvents(before, [
      { type: "compact", summary: "first summary", tailStartId: "missing" },
    ]);
    const afterCircuitBreakerSummary = applyEvents(afterFirstCompact, [
      { type: "compact", summary: "compaction failed: circuit breaker open", tailStartId: "missing" },
    ]);

    expect(afterFirstCompact.stats).toBe(stats);
    expect(afterFirstCompact.stats).toEqual(stats);
    expect(afterCircuitBreakerSummary.stats).toBe(stats);
    expect(afterCircuitBreakerSummary.stats).toEqual(stats);
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
    expect(state.stats.messages).toEqual({ user: 1, assistant: 0, total: 1 });
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
