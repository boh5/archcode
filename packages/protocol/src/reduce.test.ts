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
  ToolChildSessionLink,
} from "./types";

function createProjection(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    sessionId: "session-test",
    rootSessionId: "session-test",
    title: null,
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionLinks: [],
    stats: createEmptySessionStats(),
    executions: [],
    executionCount: 0,
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

function makeChildSessionLink(overrides: Partial<ToolChildSessionLink> = {}): ToolChildSessionLink {
  return {
    parentSessionId: "parent-1",
    parentToolCallId: "tool-call-1",
    toolName: "delegate",
    childSessionId: "child-1",
    childAgentName: "explore",
    title: "Child title",
    description: "Investigate a thing",
    depth: 1,
    background: true,
    status: "linked",
    createdAt: 100,
    ...overrides,
  };
}

describe("reduceStreamEvent", () => {
  test("defaults stats to all zeros and executions to empty for never-run sessions", () => {
    const state = createProjection();

    expect(state.stats).toEqual(createEmptySessionStats());
    expect(state.stats.tools.calls).toBe(0);
    expect(state.stats.tools.completed).toBe(0);
    expect(state.stats.tools.failed).toBe(0);
    expect(state.executions).toEqual([]);
    expect(state.executionCount).toBe(state.executions.length);
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
      { type: "execution-start" },
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
      { type: "execution-end", status: "completed" },
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

  test("records effectful tool attempt metadata on running tool part", () => {
    const state = applyEvents(createProjection(), [
      { type: "tool-call", toolCallId: "call-1", toolName: "file_write", input: { path: "a.ts" } },
      {
        type: "tool-attempt",
        toolCallId: "call-1",
        toolName: "file_write",
        attemptId: "attempt-1",
        timestamp: 99,
        destructive: true,
      },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    expect(tool.state).toBe("running");
    expect(tool.attemptId).toBe("attempt-1");
    expect(tool.attemptTimestamp).toBe(99);
    expect(tool.attemptDestructive).toBe(true);
  });

  test("missing result after recorded attempt settles as unknown-result error", () => {
    const state = applyEvents(createProjection(), [
      { type: "execution-start", executionId: "run-unknown" },
      { type: "tool-call", toolCallId: "call-1", toolName: "file_write", input: { path: "a.ts" } },
      {
        type: "tool-attempt",
        toolCallId: "call-1",
        toolName: "file_write",
        attemptId: "attempt-1",
        timestamp: 99,
        destructive: true,
      },
      { type: "execution-end", status: "interrupted" },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    expect(tool.state).toBe("error");
    if (tool.state !== "error") throw new Error("Expected error tool");
    expect(tool.errorMessage).toBe("Tool execution result unknown: execution was interrupted");
    expect(tool.meta).toEqual({ unknownResult: true });
    expect(tool.attemptId).toBe("attempt-1");
  });

  test("late result after unknown-result settlement is ignored so side effects are not replayed", () => {
    const interrupted = applyEvents(createProjection(), [
      { type: "execution-start", executionId: "run-unknown-late" },
      { type: "tool-call", toolCallId: "call-1", toolName: "file_write", input: { path: "a.ts" } },
      {
        type: "tool-attempt",
        toolCallId: "call-1",
        toolName: "file_write",
        attemptId: "attempt-1",
        timestamp: 99,
        destructive: true,
      },
      { type: "execution-end", status: "interrupted" },
    ]);

    const afterLateResult = applyEvents(interrupted, [
      { type: "tool-result", toolCallId: "call-1", toolName: "file_write", output: "late write", isError: false },
    ]);

    const tool = partOfType(onlyMessage(afterLateResult.messages), "tool");
    expect(tool.state).toBe("error");
    if (tool.state !== "error") throw new Error("Expected error tool");
    expect(tool.meta).toEqual({ unknownResult: true });
    expect(tool.errorMessage).toBe("Tool execution result unknown: execution was interrupted");
    expect(afterLateResult.stats.tools).toEqual(interrupted.stats.tools);
  });

  test("completed tool result is preserved across later recovery settlement", () => {
    const state = applyEvents(createProjection(), [
      { type: "execution-start", executionId: "run-completed" },
      { type: "tool-call", toolCallId: "call-1", toolName: "file_write", input: { path: "a.ts" } },
      {
        type: "tool-attempt",
        toolCallId: "call-1",
        toolName: "file_write",
        attemptId: "attempt-1",
        timestamp: 99,
        destructive: true,
      },
      { type: "tool-result", toolCallId: "call-1", toolName: "file_write", output: "written", isError: false },
      { type: "execution-end", status: "interrupted" },
      { type: "execution-end", status: "interrupted" },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    expect(tool.state).toBe("completed");
    if (tool.state !== "completed") throw new Error("Expected completed tool");
    expect(tool.output).toBe("written");
    expect(tool.meta?.unknownResult).toBeUndefined();
  });

  test("interrupted execution marks incomplete text and reasoning as discarded context", () => {
    const state = applyEvents(createProjection(), [
      { type: "execution-start", executionId: "run-interrupted" },
      { type: "text-start" },
      { type: "text-delta", text: "partial assistant truth" },
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "partial hidden thought" },
      { type: "execution-end", status: "interrupted" },
    ]);

    const message = onlyMessage(state.messages);
    const text = partOfType(message, "text");
    const reasoning = partOfType(message, "reasoning");
    expect(text).toMatchObject({
      text: "partial assistant truth",
      completedAt: 123456789,
      meta: { interrupted: true, discardedFromContext: true },
    });
    expect(reasoning).toMatchObject({
      text: "partial hidden thought",
      completedAt: 123456789,
      meta: { interrupted: true, discardedFromContext: true },
    });
  });

  test("failed execution marks incomplete text as discarded context", () => {
    const state = applyEvents(createProjection(), [
      { type: "execution-start", executionId: "run-failed" },
      { type: "text-start" },
      { type: "text-delta", text: "partial before failure" },
      { type: "execution-end", status: "failed", error: "stream failed" },
    ]);

    expect(partOfType(onlyMessage(state.messages), "text").meta).toEqual({
      interrupted: true,
      discardedFromContext: true,
    });
  });

  test("completed execution finalizes incomplete text without discarding it", () => {
    const state = applyEvents(createProjection(), [
      { type: "execution-start", executionId: "run-completed" },
      { type: "text-start" },
      { type: "text-delta", text: "late but accepted" },
      { type: "execution-end", status: "completed" },
    ]);

    const text = partOfType(onlyMessage(state.messages), "text");
    expect(text.completedAt).toBe(123456789);
    expect(text.meta).toBeUndefined();
  });

  test("creates a tool child session link", () => {
    const link = makeChildSessionLink();

    const state = applyEvents(createProjection(), [
      { type: "tool-child-session-link", link },
    ]);

    expect(state.childSessionLinks).toEqual([link]);
  });

  test("updates existing tool child session link by parent session, parent tool call, and child session", () => {
    const initial = makeChildSessionLink({ status: "running", startedAt: 110 });
    const completed = makeChildSessionLink({
      status: "completed",
      startedAt: 110,
      endedAt: 210,
      durationMs: 100,
      summary: "Done",
    });

    const state = applyEvents(createProjection(), [
      { type: "tool-child-session-link", link: initial },
      { type: "tool-child-session-link", link: completed },
    ]);

    expect(state.childSessionLinks).toEqual([completed]);
  });

  test("does not collapse links that share childSessionId but have different parent tool calls", () => {
    const first = makeChildSessionLink({ parentToolCallId: "tool-call-1" });
    const second = makeChildSessionLink({ parentToolCallId: "tool-call-2", status: "running" });

    const state = applyEvents(createProjection(), [
      { type: "tool-child-session-link", link: first },
      { type: "tool-child-session-link", link: second },
    ]);

    expect(state.childSessionLinks).toEqual([first, second]);
  });

  test("suppresses exact duplicate tool child session link events", () => {
    const link = makeChildSessionLink();

    const state = applyEvents(createProjection(), [
      { type: "tool-child-session-link", link },
      { type: "tool-child-session-link", link },
    ]);

    expect(state.childSessionLinks).toEqual([link]);
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
    const state = applyEvents(createProjection({ currentExecutionId: "run-1" }), [
      { type: "step-start", step: 0 },
      { type: "step-end", step: 0, finishReason: "stop", usage },
    ]);

    const step = onlyStep(state.steps);
    expect(state.isStreamingModel).toBe(false);
    expect(step.step).toBe(0);
    expect(step.executionId).toBe("run-1");
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
    const state = applyEvents(createProjection({ currentExecutionId: "run-system" }), [
      { type: "system-notice", message: "notice" },
    ]);

    const message = onlyMessage(state.messages);
    expect(message.role).toBe("user");
    expect(message.executionId).toBe("run-system");
    expect(partOfType(message, "system-notice").notice).toBe("notice");
    expect(state.stats.messages).toEqual({ user: 0, assistant: 0, total: 0 });
  });

  test("tracks execution start and end without busy errors", () => {
    const afterStart = applyEvents(
      createProjection({
        isRunning: true,
        executions: [{ id: "run-1", startedAt: 1, status: "completed", endedAt: 2, durationMs: 1 }],
        executionCount: 1,
      }),
      [{ type: "execution-start", executionId: "run-2" }],
    );

    expect(afterStart.isRunning).toBe(true);
    expect(afterStart.currentExecutionId).toBe("run-2");
    expect(afterStart.executionCount).toBe(2);
    expect(afterStart.executionCount).toBe(afterStart.executions.length);

    const afterEnd = applyEvents(afterStart, [{ type: "execution-end", status: "completed" }]);
    expect(afterEnd.isRunning).toBe(false);
    expect(afterEnd.isStreamingModel).toBe(false);
    expect(afterEnd.currentExecutionId).toBeUndefined();
    expect(afterEnd.currentAssistantMessageId).toBeUndefined();
    expect(afterEnd.executions[1]).toMatchObject({ id: "run-2", status: "completed" });
    expect(afterEnd.executionCount).toBe(afterEnd.executions.length);
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

  test("pending and running tools settled by execution-end increment failed exactly once for counted calls", () => {
    const state = applyEvents(createProjection(), [
      { type: "execution-start", executionId: "run-1" },
      { type: "tool-input-start", toolCallId: "pending", toolName: "read" },
      { type: "tool-call", toolCallId: "running", toolName: "read", input: {} },
      { type: "execution-end", status: "failed", error: "boom" },
      { type: "execution-end", status: "failed" },
    ]);

    expect(state.stats.tools).toEqual({ calls: 1, completed: 0, failed: 1 });
  });

  test("step-end usage provider variants normalize into shared usage stats", () => {
    const state = applyEvents(createProjection({ currentExecutionId: "run-usage" }), [
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
    const state = applyEvents(createProjection({ currentExecutionId: "run-usage" }), [
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

  test("computed execution id aligns executions, current execution, messages, and steps", () => {
    const state = applyEvents(createProjection(), [
      { type: "execution-start" },
      { type: "user-message", content: "hello" },
      { type: "step-start", step: 0 },
    ]);
    const executionId = state.executions[0]!.id;

    expect(state.currentExecutionId).toBe(executionId);
    expect(state.messages[0]!.executionId).toBe(executionId);
    expect(state.steps[0]!.executionId).toBe(executionId);
  });

  test("execution-end without current execution does not append a fake execution", () => {
    const state = applyEvents(createProjection(), [{ type: "execution-end", status: "completed" }]);

    expect(state.executions).toEqual([]);
    expect(state.executionCount).toBe(0);
  });

  test("executionCount equals executions.length after create, execution-start, and execution-end", () => {
    const created = createProjection();
    expect(created.executionCount).toBe(created.executions.length);

    const started = applyEvents(created, [{ type: "execution-start", executionId: "run-1" }]);
    expect(started.executionCount).toBe(started.executions.length);

    const ended = applyEvents(started, [{ type: "execution-end", status: "completed" }]);
    expect(ended.executionCount).toBe(ended.executions.length);
  });

  test("cancelled, aborted, and timed_out execution-end statuses populate latest execution", () => {
    const state = applyEvents(createProjection(), [
      { type: "execution-start", executionId: "run-cancelled" },
      { type: "execution-end", status: "cancelled", error: "cancelled by user" },
      { type: "execution-start", executionId: "run-aborted" },
      { type: "execution-end", status: "aborted", error: "abort signal" },
      { type: "execution-start", executionId: "run-timed-out" },
      { type: "execution-end", status: "timed_out", error: "deadline" },
    ]);

    expect(state.executions.map((execution) => execution.status)).toEqual(["cancelled", "aborted", "timed_out"]);
    expect(state.executions.at(-1)).toMatchObject({
      id: "run-timed-out",
      status: "timed_out",
      error: "deadline",
    });
    expect(state.executionCount).toBe(state.executions.length);
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
    const state = applyEvents(createProjection({ currentExecutionId: "run-user" }), [
      { type: "user-message", content: "hello" },
    ]);

    const message = onlyMessage(state.messages);
    expect(message.role).toBe("user");
    expect(message.executionId).toBe("run-user");
    expect(message.completedAt).toBeGreaterThan(0);
    expect(partOfType(message, "text").text).toBe("hello");
    expect(state.stats.messages).toEqual({ user: 1, assistant: 0, total: 1 });
  });

  test("records loop errors on matching or synthetic steps", () => {
    const matching = applyEvents(createProjection({ currentExecutionId: "run-error" }), [
      { type: "step-start", step: 1 },
      { type: "loop-error", step: 1, error: "bad loop" },
    ]);
    expect(onlyStep(matching.steps).error).toBe("bad loop");

    const synthetic = applyEvents(createProjection({ currentExecutionId: "run-error" }), [
      { type: "loop-error", step: 4, error: "missing step" },
    ]);
    const step = onlyStep(synthetic.steps);
    expect(step.step).toBe(4);
    expect(step.executionId).toBe("run-error");
    expect(step.error).toBe("missing step");
  });

  test("tool-input-resolved updates running tool part input with defaults", () => {
    const state = applyEvents(createProjection(), [
      { type: "tool-call", toolCallId: "call-1", toolName: "background_output", input: { session_id: "ses_abc" } },
      { type: "tool-input-resolved", toolCallId: "call-1", toolName: "background_output", input: { session_id: "ses_abc", block: false, timeout_ms: 60000 } },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    expect(tool.state).toBe("running");
    if (tool.state !== "running") throw new Error("Expected running tool");
    expect(tool.input).toEqual({ session_id: "ses_abc", block: false, timeout_ms: 60000 });
  });

  test("tool-input-resolved updates completed tool part input", () => {
    const state = applyEvents(createProjection(), [
      { type: "tool-call", toolCallId: "call-1", toolName: "background_output", input: { session_id: "ses_abc" } },
      { type: "tool-result", toolCallId: "call-1", toolName: "background_output", output: "done", isError: false },
      { type: "tool-input-resolved", toolCallId: "call-1", toolName: "background_output", input: { session_id: "ses_abc", block: false } },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    expect(tool.state).toBe("completed");
    if (tool.state !== "completed") throw new Error("Expected completed tool");
    expect(tool.input).toEqual({ session_id: "ses_abc", block: false });
  });

  test("tool-input-resolved is ignored for pending tool part", () => {
    const state = applyEvents(createProjection(), [
      { type: "tool-input-start", toolCallId: "call-1", toolName: "background_output" },
      { type: "tool-input-resolved", toolCallId: "call-1", toolName: "background_output", input: { session_id: "ses_abc", block: false } },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    expect(tool.state).toBe("pending");
    if (tool.state !== "pending") throw new Error("Expected pending tool");
    expect("input" in tool).toBe(false);
  });

  test("tool-input-resolved is ignored when toolCallId not found", () => {
    const state = applyEvents(createProjection(), [
      { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a.ts" } },
      { type: "tool-input-resolved", toolCallId: "call-unknown", toolName: "read", input: { path: "a.ts" } },
    ]);

    const tool = partOfType(onlyMessage(state.messages), "tool");
    if (tool.state === "pending") throw new Error("Expected running or settled tool");
    expect(tool.input).toEqual({ path: "a.ts" });
  });

  test("internal llm retry events are audit-only and do not create session parts", () => {
    const event: StreamEvent = {
      type: "llm-retry",
      scope: "short",
      visibility: "internal",
      profile: "short",
      attempt: 1,
      errorKind: "network",
      message: "retrying internally",
      nextRetryAt: 123456999,
      stepId: "step-1",
    };

    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    const state = applyEvents(createProjection(), [event]);

    expect(state.messages).toEqual([]);
    expect(state.stats.messages).toEqual({ user: 0, assistant: 0, total: 0 });
  });

  test("session-visible llm retry creates a recovery notice part", () => {
    const state = applyEvents(createProjection(), [
      {
        type: "llm-retry",
        scope: "session",
        visibility: "session",
        profile: "session",
        attempt: 2,
        errorKind: "rate-limit",
        message: "retry scheduled",
        nextRetryAt: 123457000,
        stepId: "step-1",
      },
    ]);

    const notice = partOfType(onlyMessage(state.messages), "recovery-notice");
    expect(notice).toMatchObject({
      id: "recovery:session:step-1",
      status: "scheduled",
      message: "retry scheduled",
      attempt: 2,
      nextRetryAt: 123457000,
      errorKind: "rate-limit",
      createdAt: 123456789,
    });
    expect(notice.completedAt).toBeUndefined();
  });

  test("session-visible recovery transitions a notice to recovered", () => {
    const state = applyEvents(createProjection(), [
      {
        type: "llm-retry",
        scope: "session",
        visibility: "session",
        attempt: 1,
        errorKind: "network",
        message: "retrying now",
        stepId: "step-1",
      },
      {
        type: "llm-recovery",
        scope: "session",
        visibility: "session",
        attempt: 1,
        message: "recovered",
        stepId: "step-1",
      },
    ]);

    const message = onlyMessage(state.messages);
    const notices = message.parts.filter((part) => part.type === "recovery-notice");
    expect(notices).toHaveLength(1);
    const notice = partOfType(message, "recovery-notice");
    expect(notice).toMatchObject({
      id: "recovery:session:step-1",
      status: "recovered",
      message: "recovered",
      attempt: 1,
      errorKind: "network",
      completedAt: 123456789,
    });
  });

  test("session-visible recovery failure transitions a notice to failed", () => {
    const state = applyEvents(createProjection(), [
      {
        type: "llm-retry",
        scope: "session",
        visibility: "session",
        attempt: 3,
        errorKind: "overloaded",
        message: "retrying",
        toolCallId: "tool-1",
      },
      {
        type: "llm-recovery-failed",
        scope: "session",
        visibility: "session",
        attempt: 3,
        errorKind: "overloaded",
        message: "recovery failed",
        toolCallId: "tool-1",
      },
    ]);

    const message = onlyMessage(state.messages);
    expect(message.parts.filter((part) => part.type === "recovery-notice")).toHaveLength(1);
    expect(partOfType(message, "recovery-notice")).toMatchObject({
      id: "recovery:session:tool-1",
      status: "failed",
      message: "recovery failed",
      attempt: 3,
      errorKind: "overloaded",
      completedAt: 123456789,
    });
  });

  test("retry and recovery events are serializable and replay-safe", () => {
    const events: StreamEvent[] = [
      { type: "execution-start", executionId: "run-retry" },
      {
        type: "llm-retry",
        scope: "session",
        visibility: "session",
        attempt: 1,
        errorKind: "network",
        message: "retrying",
        nextRetryAt: 123457000,
        messageId: "message-1",
      },
      {
        type: "llm-recovery",
        scope: "session",
        visibility: "session",
        attempt: 1,
        message: "recovered",
        messageId: "message-1",
      },
    ];
    const replayedEvents = JSON.parse(JSON.stringify(events)) as StreamEvent[];

    expect(applyEvents(createProjection(), replayedEvents)).toEqual(applyEvents(createProjection(), events));
  });

  test("recoverable attempts do not end execution and loop errors remain after recovery", () => {
    const state = applyEvents(createProjection({ currentExecutionId: "run-recover" }), [
      { type: "step-start", step: 0 },
      { type: "loop-error", step: 0, error: "transient stream error" },
      {
        type: "llm-retry",
        scope: "session",
        visibility: "session",
        attempt: 1,
        errorKind: "network",
        message: "retrying",
        stepId: "step-1",
      },
      {
        type: "llm-recovery",
        scope: "session",
        visibility: "session",
        attempt: 1,
        message: "recovered",
        stepId: "step-1",
      },
    ]);

    expect(state.isRunning).toBe(false);
    expect(state.executions).toEqual([]);
    expect(onlyStep(state.steps).error).toBe("transient stream error");
    expect(partOfType(onlyMessage(state.messages), "recovery-notice").status).toBe("recovered");
  });

  test("execution-end completes in-flight recovery notices", () => {
    const state = applyEvents(createProjection(), [
      { type: "execution-start", executionId: "run-notice" },
      {
        type: "llm-retry",
        scope: "session",
        visibility: "session",
        attempt: 1,
        errorKind: "network",
        message: "retrying",
        stepId: "step-1",
      },
      { type: "execution-end", status: "completed" },
    ]);

    expect(partOfType(onlyMessage(state.messages), "recovery-notice")).toMatchObject({
      status: "retrying",
      completedAt: 123456789,
    });
  });
});
