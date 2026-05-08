import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type FormattedToolError,
  REDACTION_MARKER,
  TOOL_ERROR_META_KEY,
  type ToolErrorKind,
  type ToolExecutionResult,
  createToolErrorResult,
  extractCode,
  formatToolError,
  inferToolErrorKindFromResult,
  isStructuredToolError,
  normalizeToolErrorResult,
} from "./index";
import { codeFromKind, kindFromCode } from "./errors";

const ALL_TOOL_ERROR_KINDS = [
  "unknown-tool",
  "prepare-input",
  "schema",
  "before-hook-schema",
  "not-allowed",
  "permission-denied",
  "permission-confirmation-denied",
  "permission-confirmation-timeout",
  "permission-confirmation-unavailable",
  "permission-confirmation-failed",
  "execution",
  "after-hook",
  "bash-nonzero",
  "bash-timeout",
  "bash-aborted",
  "cancelled",
  "read-before-write",
  "write-conflict",
  "workspace",
  "edit-no-match",
  "edit-ambiguous",
  "edit-overlap",
  "file-not-found",
  "file-permission-denied",
  "file-already-exists",
  "file-too-large",
  "edit-identical",
  "grep-error",
  "glob-error",
  "todo-validation",
] as const satisfies readonly ToolErrorKind[];

const NEW_TOOL_ERROR_KINDS = [
  "edit-overlap",
  "file-not-found",
  "file-permission-denied",
  "file-already-exists",
  "file-too-large",
  "edit-identical",
  "grep-error",
  "glob-error",
] as const satisfies readonly ToolErrorKind[];

class NamedFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamedFailure";
  }
}

function parseOutput(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

function expectString(value: unknown): asserts value is string {
  expect(typeof value).toBe("string");
}

function expectToolError(
  result: ToolExecutionResult,
  expected: { kind: ToolErrorKind; code: string; messageIncludes?: string },
) {
  expect(result.isError).toBe(true);
  expect(inferToolErrorKindFromResult(result)).toBe(expected.kind);
  const toolError = result.meta?.[TOOL_ERROR_META_KEY] as FormattedToolError | undefined;
  expect(toolError?.kind).toBe(expected.kind);
  expect(toolError?.code).toBe(expected.code);
  if (expected.messageIncludes) {
    expect(toolError?.message).toContain(expected.messageIncludes);
  }
}

describe("tool error formatter", () => {
  test("formats custom Error names with redacted message, details, and hint", () => {
    const rawSecret = "sk-test_1234567890abcdef";

    const formatted = formatToolError({
      kind: "execution",
      error: new NamedFailure(`failed token=${rawSecret}`),
      details: { stderr: `secret=${rawSecret}`, nested: { apiKey: rawSecret } },
      hint: `Retry without token=${rawSecret}`,
    });

    expect(formatted.name).toBe("NamedFailure");
    expect(formatted.code).toBe("TOOL_EXECUTION_FAILED");
    expect(formatted.message).toContain(REDACTION_MARKER);
    expect(formatted.hint).toContain(REDACTION_MARKER);
    expect(JSON.stringify(formatted)).not.toContain(rawSecret);
  });

  test("normalizes non-Error throws deterministically", () => {
    const result = createToolErrorResult({ error: { reason: "plain" } });
    const parsed = parseOutput(result.output);

    expect(parsed.name).toBe("NonErrorThrow");
    expect(parsed.code).toBe("TOOL_EXECUTION_FAILED");
    expect(parsed.message).toBe("[object Object]");
    expectString(parsed.hint);
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
  });

  test("formats Zod schema errors with expected-input details and no raw input", () => {
    const schema = z.object({ msg: z.string() }).strict();
    const parsed = schema.safeParse({ bad: "token=sk-test_1234567890abcdef" });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const result = createToolErrorResult({
        kind: "schema",
        zodError: parsed.error,
        expectedInput: "{ msg: string }",
      });
      const output = parseOutput(result.output);

      expect(output.code).toBe("TOOL_SCHEMA_INVALID_INPUT");
      expect(output.message).toContain("Unrecognized key");
      expect(output.hint).toContain("Retry with input matching the tool schema");
      expect(JSON.stringify(output)).not.toContain("sk-test_1234567890abcdef");
      expect(JSON.stringify(output)).toContain("expectedInput");
    }
  });

  test("infers actionable bash hints for nonzero, timeout, and abort", () => {
    const nonzero = normalizeToolErrorResult(
      { output: "STDERR:\nboom\nEXIT_CODE: 7", isError: true, meta: { exitCode: 7 } },
      { kind: inferToolErrorKindFromResult({ output: "", isError: true, meta: { exitCode: 7 } }) },
    );
    const timeout = normalizeToolErrorResult(
      { output: "Command timed out after 1ms", isError: true, meta: { timedOut: true } },
      { kind: inferToolErrorKindFromResult({ output: "", isError: true, meta: { timedOut: true } }) },
    );
    const aborted = normalizeToolErrorResult(
      { output: "Command was aborted", isError: true, meta: { aborted: true } },
      { kind: inferToolErrorKindFromResult({ output: "", isError: true, meta: { aborted: true } }) },
    );

    expect(parseOutput(nonzero.output).code).toBe("TOOL_BASH_NONZERO_EXIT");
    expect(parseOutput(nonzero.output).hint).toContain("exited nonzero");
    expect(parseOutput(timeout.output).code).toBe("TOOL_BASH_TIMEOUT");
    expect(parseOutput(timeout.output).hint).toContain("timed out");
    expect(parseOutput(aborted.output).code).toBe("TOOL_BASH_ABORTED");
    expect(parseOutput(aborted.output).hint).toContain("aborted or cancelled");
  });

  test("preserves existing structured errors and extracts safe codes", () => {
    const result = createToolErrorResult({
      message: "File was modified [TOOL_FILE_WRITE_CONFLICT]",
    });

    expect(isStructuredToolError(result)).toBe(true);
    expect(normalizeToolErrorResult(result)).toBe(result);
    expect(extractCode("Use file_read first [TOOL_FILE_NOT_READ_FIRST]")).toBe(
      "TOOL_FILE_NOT_READ_FIRST",
    );
  });

  test("recognizes all new ToolErrorKind values", () => {
    expect(NEW_TOOL_ERROR_KINDS).toEqual([
      "edit-overlap",
      "file-not-found",
      "file-permission-denied",
      "file-already-exists",
      "file-too-large",
      "edit-identical",
      "grep-error",
      "glob-error",
    ]);
  });

  test("round-trips every ToolErrorKind through canonical codes", () => {
    expect(ALL_TOOL_ERROR_KINDS).toHaveLength(30);

    for (const kind of ALL_TOOL_ERROR_KINDS) {
      const code = codeFromKind(kind);

      expect(code).toBeDefined();
      expectString(code);
      expect(kindFromCode(code)).toBe(kind);
    }
  });

  test("stores kind and code on structured tool error results", () => {
    const result = createToolErrorResult({
      kind: "file-not-found",
      code: "TOOL_FILE_NOT_FOUND",
      message: "test",
    });

    expectToolError(result, {
      kind: "file-not-found",
      code: "TOOL_FILE_NOT_FOUND",
      messageIncludes: "test",
    });
  });

  test("infers structured toolError kind and code before generic exitCode", () => {
    const byKind: ToolExecutionResult = {
      output: "structured edit error",
      isError: true,
      meta: {
        exitCode: 1,
        [TOOL_ERROR_META_KEY]: {
          kind: "edit-no-match",
          message: "oldString not found",
          hint: "retry with exact content",
        },
      },
    };
    const byCode: ToolExecutionResult = {
      output: "structured edit error",
      isError: true,
      meta: {
        exitCode: 1,
        [TOOL_ERROR_META_KEY]: {
          code: "TOOL_EDIT_NO_MATCH",
          message: "oldString not found",
          hint: "retry with exact content",
        },
      },
    };

    expect(inferToolErrorKindFromResult(byKind)).toBe("edit-no-match");
    expect(inferToolErrorKindFromResult(byCode)).toBe("edit-no-match");
  });

  test("keeps grep and glob structured errors distinct from bash nonzero", () => {
    const grepResult = createToolErrorResult({
      kind: "grep-error",
      message: "grep failed",
      meta: { exitCode: 2 },
    });
    const globResult = createToolErrorResult({
      kind: "glob-error",
      message: "glob failed",
      meta: { exitCode: 2 },
    });

    expectToolError(grepResult, { kind: "grep-error", code: "TOOL_GREP_ERROR" });
    expectToolError(globResult, { kind: "glob-error", code: "TOOL_GLOB_ERROR" });
  });

  test("infers file and edit kinds from message heuristics", () => {
    const cases = [
      { message: "file not found at path", kind: "file-not-found" },
      { message: "permission denied while reading", kind: "file-permission-denied" },
      { message: "target already exists", kind: "file-already-exists" },
      { message: "file is too large to read", kind: "file-too-large" },
      { message: "oldString and newString are identical", kind: "edit-identical" },
    ] as const satisfies readonly { message: string; kind: ToolErrorKind }[];

    for (const { message, kind } of cases) {
      const formatted = formatToolError({ message, code: "" });

      expect(formatted.kind).toBe(kind);
      expect(formatted.message).toContain(message);
    }
  });

  test("falls back to regex extraction when structured metadata is absent", () => {
    const result: ToolExecutionResult = {
      output: "Edit failed [TOOL_EDIT_AMBIGUOUS_MATCH]",
      isError: true,
      meta: {},
    };

    expect(inferToolErrorKindFromResult(result)).toBe("edit-ambiguous");
  });

  test("provides hint coverage for every ToolErrorKind", () => {
    for (const kind of ALL_TOOL_ERROR_KINDS) {
      const formatted = formatToolError({ kind, message: `message for ${kind}` });

      expectString(formatted.hint);
      expect(formatted.hint.length).toBeGreaterThan(0);
    }

    expect(formatToolError({ kind: "file-not-found" }).hint).toContain("does not exist");
    expect(formatToolError({ kind: "file-permission-denied" }).hint).toContain("Permission denied");
    expect(formatToolError({ kind: "file-already-exists" }).hint).toContain("already exists");
    expect(formatToolError({ kind: "file-too-large" }).hint).toContain("too large");
    expect(formatToolError({ kind: "edit-identical" }).hint).toContain("identical");
    expect(formatToolError({ kind: "grep-error" }).hint).toContain("search command failed");
    expect(formatToolError({ kind: "glob-error" }).hint).toContain("file listing command failed");
  });
});
