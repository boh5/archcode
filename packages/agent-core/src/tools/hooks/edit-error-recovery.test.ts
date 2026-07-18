import { describe, expect, test } from "bun:test";
import { storeManager } from "../../store/store";
import type { RawToolResult, ToolExecutionContext } from "../types";
import { createTextToolResult } from "../results";
import {
  createToolErrorResult,
  inferToolErrorKindFromResult,
  isStructuredToolError,
} from "../errors";
import { createEditErrorRecoveryHook } from "./edit-error-recovery";
import { createTestProjectContext } from "../test-project-context";

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return { store: {} as ToolExecutionContext["store"],
  toolName: "file_edit",
  toolCallId: "call-edit-001",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set<string>(),
  cwd: "/tmp",
  storeManager,
    projectContext: createTestProjectContext("/tmp"), ...overrides,  };
}

function makeResult(input: { output?: string; isError?: boolean; details?: RawToolResult["details"] } = {}): RawToolResult {
  return createTextToolResult(input.output ?? "", {
    isError: input.isError,
    details: input.details,
  });
}

function rawText(result: RawToolResult): string {
  if (result.draft.kind !== "text") throw new Error("Expected text draft");
  return result.draft.text;
}

describe("createEditErrorRecoveryHook", () => {
  test("returns undefined when result is not an error", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({ output: "File edited successfully", isError: false });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
  });

  test("does not modify non-error result meta", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "success",
      isError: false,
      details: { process: { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 42 } },
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
  });

  test("appends nudge for TOOL_FILE_NOT_READ_FIRST error", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "[TOOL_FILE_NOT_READ_FIRST] Cannot edit /path/to/file.ts",
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "You must read the file first using file_read before editing it.",
    );
  });

  test("appends kind-based nudge for structured edit errors", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = createToolErrorResult({
      kind: "edit-no-match",
      code: "TOOL_EDIT_NO_MATCH",
      message: "oldString not found in file",
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "The oldString was not found in the file.",
    );
    expect(returned!.details?.error).toEqual(result.details?.error);
    expect(isStructuredToolError(returned!)).toBe(true);
    expect(inferToolErrorKindFromResult(returned!)).toBe("edit-no-match");
  });

  test("returns structured errors without mapped nudges as-is", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = createToolErrorResult({
      kind: "execution",
      code: "TOOL_EXECUTION_FAILED",
      message: "Unexpected edit failure",
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBe(result);
    expect(rawText(returned!)).not.toContain("\n---\n");
    expect(isStructuredToolError(returned!)).toBe(true);
    expect(inferToolErrorKindFromResult(returned!)).toBe("execution");
  });

  test("appends kind-based nudge for structured identical edit errors", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = createToolErrorResult({
      kind: "edit-identical",
      code: "TOOL_EDIT_IDENTICAL",
      message: "oldString and newString are identical",
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "oldString and newString are identical; change newString or skip this edit.",
    );
    expect(returned!.details?.error).toEqual(result.details?.error);
    expect(isStructuredToolError(returned!)).toBe(true);
  });

  test("appends nudge for TOOL_FILE_WRITE_CONFLICT error", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "[TOOL_FILE_WRITE_CONFLICT] File mtime changed for /path/to/file.ts",
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "The file was modified externally since you last read it.",
    );
  });

  test("appends nudge when output contains 'not found' pattern (oldString)", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "Error: oldString 'foo' not found in file content",
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "The oldString was not found in the file.",
    );
  });

  test("appends nudge when output contains 'no match' pattern", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "Error: no match found for oldString",
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "The oldString was not found in the file.",
    );
  });

  test("appends nudge when output contains 'multiple matches' pattern", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "Error: multiple matches found for oldString; provide more context",
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "The oldString matched multiple locations in the file.",
    );
  });

  test("appends nudge when output contains 'ambiguous' pattern", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "Error: ambiguous match — multiple locations found",
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "The oldString matched multiple locations in the file.",
    );
  });

  test("appends nudge when output contains 'overlapping edits' pattern", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "Error: overlapping edits detected",
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "The edits overlap with each other.",
    );
  });

  test("appends fallback nudge for unrecognized error", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "Some unknown error occurred during edit",
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "The edit failed. Try re-reading the file and ensuring your oldString exactly matches the current content.",
    );
  });

  test("preserves original error message before separator", async () => {
    const hook = createEditErrorRecoveryHook();
    const originalMsg = "[TOOL_FILE_NOT_READ_FIRST] Cannot edit /path/to/file.ts";
    const result = makeResult({
      output: originalMsg,
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toStartWith(originalMsg);
    expect(rawText(returned!)).toContain("\n---\n");
  });

  test("preserves strict details from original result when modifying output", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "Error: oldString not found",
      isError: true,
      details: { process: { exitCode: 1, signal: null, timedOut: false, aborted: false, durationMs: 1 } },
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(returned!.details).toEqual(result.details);
  });

  test("handles case-insensitive matching for patterns", async () => {
    const hook = createEditErrorRecoveryHook();
    const result = makeResult({
      output: "ERROR: Multiple Matches Found",
      isError: true,
    });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).not.toBeUndefined();
    expect(rawText(returned!)).toContain(
      "The oldString matched multiple locations in the file.",
    );
  });
});
