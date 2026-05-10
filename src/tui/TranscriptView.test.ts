import { describe, expect, test } from "bun:test";
import {
  buildRenderBlocks,
  formatLoopError,
  formatReasoningPart,
  formatStreamingText,
  formatTextPart,
  formatToolCall,
  formatToolResult,
  formatUserMessage,
} from "./TranscriptView";
import type {
  StoredMessage,
  StoredPart,
  StreamingTextState,
  StreamingReasoningState,
  StreamingToolState,
  TextPart,
  ReasoningPart,
  PendingToolPart,
  RunningToolPart,
  CompletedToolPart,
  ErrorToolPart,
  Reminder,
} from "../store/types";

const now = Date.now();

function makeTextPart(overrides: Partial<TextPart> = {}): TextPart {
  return {
    type: "text",
    id: crypto.randomUUID(),
    text: "",
    createdAt: now,
    ...overrides,
  };
}

function makeReasoningPart(overrides: Partial<ReasoningPart> = {}): ReasoningPart {
  return {
    type: "reasoning",
    id: crypto.randomUUID(),
    text: "",
    createdAt: now,
    ...overrides,
  };
}

function makePendingToolPart(overrides: Partial<PendingToolPart> = {}): PendingToolPart {
  return {
    type: "tool",
    id: crypto.randomUUID(),
    state: "pending",
    toolCallId: crypto.randomUUID(),
    toolName: "testTool",
    createdAt: now,
    ...overrides,
  };
}

function makeRunningToolPart(overrides: Partial<RunningToolPart> = {}): RunningToolPart {
  return {
    type: "tool",
    id: crypto.randomUUID(),
    state: "running",
    toolCallId: crypto.randomUUID(),
    toolName: "testTool",
    input: {},
    createdAt: now,
    startedAt: now,
    ...overrides,
  };
}

function makeCompletedToolPart(overrides: Partial<CompletedToolPart> = {}): CompletedToolPart {
  return {
    type: "tool",
    id: crypto.randomUUID(),
    state: "completed",
    toolCallId: crypto.randomUUID(),
    toolName: "testTool",
    input: {},
    output: "done",
    createdAt: now,
    startedAt: now,
    endedAt: now,
    ...overrides,
  };
}

function makeErrorToolPart(overrides: Partial<ErrorToolPart> = {}): ErrorToolPart {
  return {
    type: "tool",
    id: crypto.randomUUID(),
    state: "error",
    toolCallId: crypto.randomUUID(),
    toolName: "testTool",
    input: {},
    errorMessage: "failed",
    createdAt: now,
    startedAt: now,
    endedAt: now,
    ...overrides,
  };
}

function makeUserMessage(parts: TextPart[] = []): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: parts.length > 0 ? parts : [makeTextPart({ text: "hello", completedAt: now })],
    createdAt: now,
    completedAt: now,
  };
}

function makeAssistantMessage(parts: StoredPart[] = []): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts,
    createdAt: now,
  };
}

describe("formatUserMessage", () => {
  test("formats basic input", () => {
    expect(formatUserMessage("hello")).toBe("> hello");
  });

  test("formats empty string", () => {
    expect(formatUserMessage("")).toBe("> ");
  });

  test("formats multiline content", () => {
    expect(formatUserMessage("line one\nline two")).toBe("> line one\nline two");
  });
});

describe("formatTextPart", () => {
  test("returns text unchanged", () => {
    expect(formatTextPart("Hello world")).toBe("Hello world");
  });

  test("handles empty string", () => {
    expect(formatTextPart("")).toBe("");
  });
});

describe("formatStreamingText", () => {
  test("returns streaming text content", () => {
    const streaming: StreamingTextState = {
      messageId: crypto.randomUUID(),
      partId: crypto.randomUUID(),
      text: "streaming content",
    };
    expect(formatStreamingText(streaming)).toBe("streaming content");
  });

  test("returns empty string for empty streaming text", () => {
    const streaming: StreamingTextState = {
      messageId: crypto.randomUUID(),
      partId: crypto.randomUUID(),
      text: "",
    };
    expect(formatStreamingText(streaming)).toBe("");
  });
});

describe("formatReasoningPart", () => {
  test("formats reasoning with label", () => {
    expect(formatReasoningPart("thinking about it")).toBe("💭 thinking about it");
  });

  test("handles empty string", () => {
    expect(formatReasoningPart("")).toBe("💭 ");
  });
});

describe("formatToolCall", () => {
  test("formats a tool name", () => {
    expect(formatToolCall("readFile")).toBe("⚙ readFile");
  });
});

describe("formatToolResult", () => {
  test("formats successful output", () => {
    expect(formatToolResult("done", false)).toBe("✓ done");
  });

  test("formats error output", () => {
    expect(formatToolResult("failed", true)).toBe("✗ failed");
  });

  test("truncates long output to 200 characters plus ellipsis", () => {
    const output = "a".repeat(250);
    expect(formatToolResult(output, false)).toBe(`✓ ${"a".repeat(200)}...`);
  });
});

describe("formatLoopError", () => {
  test("formats an error message", () => {
    expect(formatLoopError("max steps reached")).toBe("✗ max steps reached");
  });
});

describe("buildRenderBlocks", () => {
  test("empty messages returns empty blocks", () => {
    expect(buildRenderBlocks([])).toEqual([]);
  });

  test("user message renders gray block with > prefix", () => {
    const msg = makeUserMessage([makeTextPart({ text: "Hi there", completedAt: now })]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("> Hi there");
    expect(blocks[0].color).toBe("gray");
  });

  test("completed assistant text renders normal text block", () => {
    const msg = makeAssistantMessage([makeTextPart({ text: "Response text", completedAt: now })]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("Response text");
    expect(blocks[0].color).toBeUndefined();
  });

  test("streaming text renders live text block", () => {
    const partId = crypto.randomUUID();
    const msgId = crypto.randomUUID();
    const msg = makeAssistantMessage([makeTextPart({ id: partId, text: "", completedAt: undefined })]);
    msg.id = msgId;
    const streaming: StreamingTextState = { messageId: msgId, partId, text: "streaming..." };
    const blocks = buildRenderBlocks([msg], streaming);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("streaming...");
  });

  test("incomplete text part without streaming is skipped", () => {
    const msg = makeAssistantMessage([makeTextPart({ text: "", completedAt: undefined })]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(0);
  });

  test("completed reasoning renders reasoning block", () => {
    const msg = makeAssistantMessage([makeReasoningPart({ text: "deep thought", completedAt: now })]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("💭 deep thought");
  });

  test("streaming reasoning renders live reasoning block", () => {
    const partId = crypto.randomUUID();
    const msgId = crypto.randomUUID();
    const msg = makeAssistantMessage([makeReasoningPart({ id: partId, text: "", completedAt: undefined })]);
    msg.id = msgId;
    const streaming: StreamingReasoningState = { messageId: msgId, partId, text: "thinking..." };
    const blocks = buildRenderBlocks([msg], undefined, streaming);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("💭 thinking...");
  });

  test("tool pending renders tool name block (yellow)", () => {
    const msg = makeAssistantMessage([makePendingToolPart({ toolName: "readFile" })]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("⚙ readFile");
    expect(blocks[0].color).toBe("yellow");
  });

  test("tool running renders tool name with running indicator (yellow)", () => {
    const msg = makeAssistantMessage([makeRunningToolPart({ toolName: "readFile" })]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("⚙ readFile (running)");
    expect(blocks[0].color).toBe("yellow");
  });

  test("tool completed renders tool call + result blocks", () => {
    const msg = makeAssistantMessage([makeCompletedToolPart({ toolName: "readFile", output: "file contents" })]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe("⚙ readFile");
    expect(blocks[0].color).toBe("yellow");
    expect(blocks[1].content).toBe("✓ file contents");
    expect(blocks[1].color).toBe("green");
  });

  test("tool error renders tool call + error result blocks", () => {
    const msg = makeAssistantMessage([makeErrorToolPart({ toolName: "readFile", errorMessage: "not found" })]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe("⚙ readFile");
    expect(blocks[0].color).toBe("yellow");
    expect(blocks[1].content).toBe("✗ not found");
    expect(blocks[1].color).toBe("red");
  });

  test("mixed assistant message preserves part order", () => {
    const textPart = makeTextPart({ text: "Hello", completedAt: now });
    const toolPart = makeCompletedToolPart({ toolName: "bash", output: "ok" });
    const textPart2 = makeTextPart({ text: "Done", completedAt: now });
    const msg = makeAssistantMessage([textPart, toolPart, textPart2]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(4);
    expect(blocks[0].content).toBe("Hello");
    expect(blocks[1].content).toBe("⚙ bash");
    expect(blocks[2].content).toBe("✓ ok");
    expect(blocks[3].content).toBe("Done");
  });

  test("orphan streamingText renders even without matching part", () => {
    const streaming: StreamingTextState = {
      messageId: crypto.randomUUID(),
      partId: crypto.randomUUID(),
      text: "orphan text",
    };
    const blocks = buildRenderBlocks([], streaming);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("orphan text");
  });

  test("orphan streamingReasoning renders even without matching part", () => {
    const streaming: StreamingReasoningState = {
      messageId: crypto.randomUUID(),
      partId: crypto.randomUUID(),
      text: "orphan reasoning",
    };
    const blocks = buildRenderBlocks([], undefined, streaming);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("💭 orphan reasoning");
  });

  test("streaming tool not in message parts renders tool name", () => {
    const streamingTools: Record<string, StreamingToolState> = {
      call123: {
        messageId: crypto.randomUUID(),
        partId: crypto.randomUUID(),
        toolCallId: "call123",
        toolName: "readFile",
      },
    };
    const blocks = buildRenderBlocks([], undefined, undefined, streamingTools);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("⚙ readFile");
    expect(blocks[0].color).toBe("yellow");
  });

  test("streaming tool already in message parts is not duplicated", () => {
    const toolCallId = "call123";
    const msg = makeAssistantMessage([makePendingToolPart({ toolCallId, toolName: "readFile" })]);
    const streamingTools: Record<string, StreamingToolState> = {
      [toolCallId]: {
        messageId: msg.id,
        partId: msg.parts[0].id,
        toolCallId,
        toolName: "readFile",
      },
    };
    const blocks = buildRenderBlocks([msg], undefined, undefined, streamingTools);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("⚙ readFile");
  });
});

describe("todo_write tool rendering", () => {
  test("pending todo_write renders updating message", () => {
    const msg = makeAssistantMessage([
      makePendingToolPart({ toolName: "todo_write" }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("⚙ Updating todos...");
    expect(blocks[0].color).toBe("yellow");
  });

  test("running todo_write renders updating message", () => {
    const msg = makeAssistantMessage([
      makeRunningToolPart({ toolName: "todo_write", input: { todos: [] } }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("⚙ Updating todos...");
    expect(blocks[0].color).toBe("yellow");
  });

  test("completed todo_write renders todo list with status icons", () => {
    const todos = [
      { id: "todo-1", content: "Fix auth bug", status: "in_progress" },
      { id: "todo-2", content: "Write tests", status: "pending" },
      { id: "todo-3", content: "Update docs", status: "completed" },
      { id: "todo-4", content: "Remove old API", status: "cancelled" },
    ];
    const msg = makeAssistantMessage([
      makeCompletedToolPart({
        toolName: "todo_write",
        input: { todos },
      }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(5);
    expect(blocks[0].content).toBe("# Todos");
    expect(blocks[0].color).toBe("yellow");
    expect(blocks[0].bold).toBe(true);
    expect(blocks[1].content).toBe("  ◉ Fix auth bug");
    expect(blocks[1].color).toBe("yellow");
    expect(blocks[2].content).toBe("  ○ Write tests");
    expect(blocks[2].color).toBeUndefined();
    expect(blocks[3].content).toBe("  ✓ Update docs");
    expect(blocks[3].color).toBe("green");
    expect(blocks[4].content).toBe("  ✕ Remove old API");
    expect(blocks[4].color).toBe("gray");
  });

  test("completed todo_write with empty todos renders header only", () => {
    const msg = makeAssistantMessage([
      makeCompletedToolPart({
        toolName: "todo_write",
        input: { todos: [] },
      }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("# Todos");
  });

  test("completed todo_write with missing input renders header only", () => {
    const msg = makeAssistantMessage([
      makeCompletedToolPart({
        toolName: "todo_write",
        input: {},
      }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("# Todos");
  });

  test("completed todo_write with null input renders header only", () => {
    const msg = makeAssistantMessage([
      makeCompletedToolPart({
        toolName: "todo_write",
        input: null,
      }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("# Todos");
  });

  test("completed todo_write with malformed todos array ignores bad entries", () => {
    const msg = makeAssistantMessage([
      makeCompletedToolPart({
        toolName: "todo_write",
        input: {
          todos: [
            { id: "1", content: "Valid todo", status: "pending" },
            { status: "completed" },
            null,
            "not an object",
            { id: "2", content: "Another valid", status: "in_progress" },
          ],
        },
      }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].content).toBe("# Todos");
    expect(blocks[1].content).toBe("  ○ Valid todo");
    expect(blocks[2].content).toBe("  ◉ Another valid");
  });

  test("completed todo_write with non-array todos renders header only", () => {
    const msg = makeAssistantMessage([
      makeCompletedToolPart({
        toolName: "todo_write",
        input: { todos: "not an array" },
      }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("# Todos");
  });

  test("error todo_write renders error blocks", () => {
    const msg = makeAssistantMessage([
      makeErrorToolPart({
        toolName: "todo_write",
        errorMessage: "Only one todo can be in_progress",
      }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe("⚙ todo_write");
    expect(blocks[0].color).toBe("yellow");
    expect(blocks[1].content).toBe("✗ Only one todo can be in_progress");
    expect(blocks[1].color).toBe("red");
  });

  test("non-todo_write tool still renders normally", () => {
    const msg = makeAssistantMessage([
      makeCompletedToolPart({ toolName: "file_read", output: "file contents" }),
    ]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe("⚙ file_read");
    expect(blocks[1].content).toBe("✓ file contents");
  });
});

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: crypto.randomUUID(),
    source: { type: "todo_continuation", pendingTodos: [] },
    delivery: "auto_inject",
    content: "Continue working",
    createdAt: now,
    consumedAt: null,
    ...overrides,
  };
}

describe("buildRenderBlocks with reminders", () => {
  test("no reminders: backward compatible rendering", () => {
    const msg = makeUserMessage([makeTextPart({ text: "hello", completedAt: now })]);
    const blocks = buildRenderBlocks([msg]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("> hello");
  });

  test("undefined reminders: backward compatible rendering", () => {
    const msg = makeUserMessage([makeTextPart({ text: "hello", completedAt: now })]);
    const blocks = buildRenderBlocks([msg], undefined, undefined, {}, undefined);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("> hello");
  });

  test("empty reminders: backward compatible rendering", () => {
    const msg = makeUserMessage([makeTextPart({ text: "hello", completedAt: now })]);
    const blocks = buildRenderBlocks([msg], undefined, undefined, {}, []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("> hello");
  });

  test("reminders merged with messages by timestamp", () => {
    const t1 = 1000;
    const t2 = 2000;
    const t3 = 3000;

    const msg1 = makeUserMessage([makeTextPart({ text: "first", completedAt: t1 })]);
    msg1.createdAt = t1;
    const msg2 = makeUserMessage([makeTextPart({ text: "third", completedAt: t3 })]);
    msg2.createdAt = t3;

    const reminder = makeReminder({ content: "second", createdAt: t2 });

    const blocks = buildRenderBlocks([msg1, msg2], undefined, undefined, {}, [reminder]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].content).toBe("> first");
    expect(blocks[1].content).toBe("💬 second");
    expect(blocks[2].content).toBe("> third");
  });

  test("tie-breaker: same timestamp puts message before reminder", () => {
    const t = 1000;
    const msg = makeUserMessage([makeTextPart({ text: "message first", completedAt: t })]);
    msg.createdAt = t;
    const reminder = makeReminder({ content: "reminder second", createdAt: t });

    const blocks = buildRenderBlocks([msg], undefined, undefined, {}, [reminder]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe("> message first");
    expect(blocks[1].content).toBe("💬 reminder second");
  });

  test("consumed reminders still visible with [handled] suffix", () => {
    const reminder = makeReminder({
      content: "Task completed",
      consumedAt: 5000,
    });

    const blocks = buildRenderBlocks([], undefined, undefined, {}, [reminder]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("💬 Task completed [handled]");
    expect(blocks[0].color).toBe("gray");
  });

  test("auto_inject reminders render", () => {
    const reminder = makeReminder({
      delivery: "auto_inject",
      content: "Auto-injected reminder",
    });

    const blocks = buildRenderBlocks([], undefined, undefined, {}, [reminder]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("💬 Auto-injected reminder");
  });

  test("on_demand reminders render", () => {
    const reminder = makeReminder({
      delivery: "on_demand",
      content: "On-demand reminder",
    });

    const blocks = buildRenderBlocks([], undefined, undefined, {}, [reminder]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("💬 On-demand reminder");
  });

  test("reminder block has gray color", () => {
    const reminder = makeReminder({ content: "test" });
    const blocks = buildRenderBlocks([], undefined, undefined, {}, [reminder]);
    expect(blocks[0].color).toBe("gray");
  });

  test("reminder block id uses reminder: prefix", () => {
    const reminder = makeReminder({ id: "rem-123" });
    const blocks = buildRenderBlocks([], undefined, undefined, {}, [reminder]);
    expect(blocks[0].id).toBe("reminder:rem-123");
  });

  test("multiple reminders sorted by createdAt", () => {
    const r1 = makeReminder({ content: "late", createdAt: 3000 });
    const r2 = makeReminder({ content: "early", createdAt: 1000 });
    const r3 = makeReminder({ content: "mid", createdAt: 2000 });

    const blocks = buildRenderBlocks([], undefined, undefined, {}, [r1, r2, r3]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].content).toBe("💬 early");
    expect(blocks[1].content).toBe("💬 mid");
    expect(blocks[2].content).toBe("💬 late");
  });

  test("reminders interleaved with assistant messages by timestamp", () => {
    const t1 = 1000;
    const t2 = 2000;

    const msg = makeAssistantMessage([makeTextPart({ text: "response", completedAt: t2 })]);
    msg.createdAt = t2;
    const reminder = makeReminder({ content: "reminder", createdAt: t1 });

    const blocks = buildRenderBlocks([msg], undefined, undefined, {}, [reminder]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe("💬 reminder");
    expect(blocks[1].content).toBe("response");
  });
});