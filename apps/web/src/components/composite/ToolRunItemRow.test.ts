import { describe, expect, test } from "bun:test";
import type { CompletedToolPart, ErrorToolPart, RunningToolPart } from "@archcode/protocol";
import { toolRunItemNeedsDetails } from "./ToolRunItemRow";

function completed(): CompletedToolPart {
  return {
    type: "tool",
    id: "tool",
    state: "completed",
    toolCallId: "call-tool",
    toolName: "file_read",
    input: { path: "README.md" },
    result: {
      isError: false,
      output: {
        preview: "",
        completeness: "complete",
        observed: { bytes: 0, lines: 0 },
        canonical: { bytes: 0, lines: 0 },
        stored: { bytes: 0, lines: 0 },
        omitted: { bytes: 0, lines: 0 },
        recovery: { kind: "none" },
      },
    },
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
  };
}

describe("toolRunItemNeedsDetails", () => {
  test("keeps successful ordinary calls as static rows", () => {
    expect(toolRunItemNeedsDetails(completed())).toBe(false);
    expect(toolRunItemNeedsDetails({
      ...completed(),
      state: "running",
    } as RunningToolPart)).toBe(false);
  });

  test("routes a grouped running Bash preview through its full ToolCard", () => {
    expect(toolRunItemNeedsDetails({
      type: "tool",
      id: "bash",
      state: "running",
      toolCallId: "call-bash",
      toolName: "bash",
      input: { command: "printf live", description: "Print output" },
      liveOutput: {
        preview: "live",
        omittedBytes: 0,
        liveLimitReached: false,
      },
      createdAt: 1,
      startedAt: 1,
    })).toBe(true);
  });

  test("preserves detail access for errors, unknown outcomes, and output artifacts", () => {
    expect(toolRunItemNeedsDetails({
      ...completed(),
      state: "error",
      result: { ...completed().result, isError: true },
    } as ErrorToolPart)).toBe(true);
    expect(toolRunItemNeedsDetails({
      ...completed(),
      result: {
        ...completed().result,
        details: { unknownResult: true },
      },
    })).toBe(true);
    expect(toolRunItemNeedsDetails({
      ...completed(),
      result: {
        ...completed().result,
        details: {
          error: {
            kind: "execution",
            code: "FILE_READ_FAILED",
            name: "File read failed",
          },
        },
      },
    })).toBe(true);
    expect(toolRunItemNeedsDetails({
      ...completed(),
      result: {
        ...completed().result,
        output: {
          ...completed().result.output,
          recovery: {
            kind: "artifact",
            outputRef: "abcdefghijklmnopqrstuv",
            expiresAt: 10,
            canRead: true,
            canSearch: true,
          },
        },
      },
    })).toBe(true);
  });
});
