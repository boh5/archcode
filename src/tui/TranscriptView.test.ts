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