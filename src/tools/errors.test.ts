import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  REDACTION_MARKER,
  TOOL_ERROR_META_KEY,
  createToolErrorResult,
  extractCode,
  formatToolError,
  inferToolErrorKindFromResult,
  isStructuredToolError,
  normalizeToolErrorResult,
} from "./index";

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
});
