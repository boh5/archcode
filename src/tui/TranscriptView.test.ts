import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  formatLoopError,
  formatTextDeltas,
  formatToolCall,
  formatToolResult,
  formatUserMessage,
} from "./TranscriptView";
import type { TextDeltaEvent } from "../store/types";

function makeTextDelta(overrides: Partial<TextDeltaEvent> = {}): TextDeltaEvent {
  return {
    type: "text-delta",
    id: randomUUID(),
    timestamp: Date.now(),
    step: 0,
    text: "",
    ...overrides,
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

describe("formatTextDeltas", () => {
  test("returns empty string for empty events", () => {
    expect(formatTextDeltas([])).toBe("");
  });

  test("formats a single event", () => {
    expect(formatTextDeltas([makeTextDelta({ text: "Hello" })])).toBe("Hello");
  });

  test("concatenates multiple events in the same step", () => {
    expect(formatTextDeltas([
      makeTextDelta({ step: 1, text: "Hello" }),
      makeTextDelta({ step: 1, text: " world" }),
    ])).toBe("Hello world");
  });

  test("groups events across different steps with an empty line", () => {
    expect(formatTextDeltas([
      makeTextDelta({ step: 0, text: "First" }),
      makeTextDelta({ step: 0, text: " step" }),
      makeTextDelta({ step: 1, text: "Second" }),
      makeTextDelta({ step: 1, text: " step" }),
      makeTextDelta({ step: 2, text: "Third" }),
    ])).toBe("First step\n\nSecond step\n\nThird");
  });

  test("preserves empty text strings", () => {
    expect(formatTextDeltas([
      makeTextDelta({ step: 0, text: "" }),
      makeTextDelta({ step: 0, text: "A" }),
      makeTextDelta({ step: 1, text: "" }),
    ])).toBe("A\n\n");
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
