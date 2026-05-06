import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
    id: randomUUID(),
    text: "",
    createdAt: now,
    ...overrides,
  };
}

function makeReasoningPart(overrides: Partial<ReasoningPart> = {}): ReasoningPart {
  return {
    type: "reasoning",
    id: randomUUID(),
    text: "",
    createdAt: now,
    ...overrides,
  };
}

function makePendingToolPart(overrides: Partial<PendingToolPart> = {}): PendingToolPart {
  return {
    type: "tool",
    id: randomUUID(),
    state: "pending",
    toolCallId: randomUUID(),
    toolName: "testTool",
    createdAt: now,
    ...overrides,
  };
}

function makeRunningToolPart(overrides: Partial<RunningToolPart> = {}): RunningToolPart {
  return {
    type: "tool",
    id: randomUUID(),
    state: "running",
    toolCallId: randomUUID(),
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
    id: randomUUID(),
    state: "completed",
    toolCallId: randomUUID(),
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
    id: randomUUID(),
    state: "error",
    toolCallId: randomUUID(),
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
    id: randomUUID(),
    role: "user",
    parts: parts.length > 0 ? parts : [makeTextPart({ text: "hello", completedAt: now })],
    createdAt: now,
    completedAt: now,
  };
}

function makeAssistantMessage(parts: StoredPart[] = []): StoredMessage {
  return {
    id: randomUUID(),
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
      messageId: randomUUID(),
      partId: randomUUID(),
      text: "streaming content",
    };
    expect(formatStreamingText(streaming)).toBe("streaming content");
  });

  test("returns empty string for empty streaming text", () => {
    const streaming: StreamingTextState = {
      messageId: randomUUID(),
      partId: randomUUID(),
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
    const partId = randomUUID();
    const msgId = randomUUID();
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
    const partId = randomUUID();
    const msgId = randomUUID();
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
      messageId: randomUUID(),
      partId: randomUUID(),
      text: "orphan text",
    };
    const blocks = buildRenderBlocks([], streaming);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("orphan text");
  });

  test("orphan streamingReasoning renders even without matching part", () => {
    const streaming: StreamingReasoningState = {
      messageId: randomUUID(),
      partId: randomUUID(),
      text: "orphan reasoning",
    };
    const blocks = buildRenderBlocks([], undefined, streaming);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("💭 orphan reasoning");
  });

  test("streaming tool not in message parts renders tool name", () => {
    const streamingTools: Record<string, StreamingToolState> = {
      call123: {
        messageId: randomUUID(),
        partId: randomUUID(),
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