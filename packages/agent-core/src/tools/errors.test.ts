import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { utf8ByteLength } from "../tool-output/utf8";
import {
  TOOL_ERROR_HINT_MAX_BYTES,
  TOOL_ERROR_IDENTIFIER_MAX_BYTES,
  TOOL_ERROR_MESSAGE_MAX_BYTES,
  codeFromKind,
  createToolErrorResult,
  formatToolError,
  inferToolErrorKindFromResult,
  isStructuredToolError,
  kindFromCode,
  normalizeToolErrorResult,
} from "./errors";
import { REDACTION_MARKER } from "../security";

function resultText(result: ReturnType<typeof createToolErrorResult>): string {
  if (result.draft.kind !== "text") throw new Error("Expected a text draft");
  return result.draft.text;
}

describe("tool error formatter", () => {
  test("redacts messages and bounds every caller-controlled field", () => {
    const secret = "sk-test_1234567890abcdef";
    const formatted = formatToolError({
      error: new Error(`token=${secret}${"😀".repeat(20_000)}`),
      name: "n".repeat(1_000),
      code: "C".repeat(1_000),
      hint: `token=${secret}${"界".repeat(3_000)}`,
    });

    expect(formatted.message).toContain(REDACTION_MARKER);
    expect(JSON.stringify(formatted)).not.toContain(secret);
    expect(utf8ByteLength(formatted.message)).toBeLessThanOrEqual(TOOL_ERROR_MESSAGE_MAX_BYTES);
    expect(utf8ByteLength(formatted.hint)).toBeLessThanOrEqual(TOOL_ERROR_HINT_MAX_BYTES);
    expect(utf8ByteLength(formatted.name)).toBeLessThanOrEqual(TOOL_ERROR_IDENTIFIER_MAX_BYTES);
    expect(utf8ByteLength(formatted.code)).toBeLessThanOrEqual(TOOL_ERROR_IDENTIFIER_MAX_BYTES);
    expect(JSON.stringify(formatted)).not.toContain("�");
  });

  test("constructs a bounded Raw result for a huge thrown exception", () => {
    const result = createToolErrorResult({
      error: new Error("😀".repeat(250_000)),
    });
    const text = resultText(result);
    const parsed = JSON.parse(text) as Record<string, string>;

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(utf8ByteLength(parsed.message ?? "")).toBeLessThanOrEqual(TOOL_ERROR_MESSAGE_MAX_BYTES);
    expect(utf8ByteLength(text)).toBeLessThan(40 * 1024);
    expect(text).not.toContain("�");
  });

  test("bounds Zod messages before constructing the Raw contract", () => {
    const schema = z.object({ value: z.literal("expected") }).strict();
    const parsed = schema.safeParse({ value: "x".repeat(100_000) });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const result = createToolErrorResult({ kind: "schema", zodError: parsed.error });
    const error = JSON.parse(resultText(result)) as Record<string, string>;
    expect(error.code).toBe("TOOL_SCHEMA_INVALID_INPUT");
    expect(utf8ByteLength(error.message ?? "")).toBeLessThanOrEqual(TOOL_ERROR_MESSAGE_MAX_BYTES);
  });

  test("uses the transport limit hint without exposing a retired input knob", () => {
    const formatted = formatToolError({ kind: "webfetch-size-exceeded" });
    expect(formatted.hint).toContain("5 MiB transport safety limit");
    expect(formatted.hint).not.toContain("maxLength");
  });

  test("normalizes unstructured failures and preserves structured failures", () => {
    const unstructured = {
      isError: true,
      draft: { kind: "text" as const, text: "file not found" },
    };
    const normalized = normalizeToolErrorResult(unstructured);

    expect(isStructuredToolError(normalized)).toBe(true);
    expect(inferToolErrorKindFromResult(normalized)).toBe("execution");
    expect(normalizeToolErrorResult(normalized)).toBe(normalized);
  });

  test("infers process failures and round-trips canonical codes", () => {
    expect(inferToolErrorKindFromResult({
      isError: true,
      draft: { kind: "text", text: "failed" },
      details: {
        process: {
          exitCode: 7,
          signal: null,
          timedOut: false,
          aborted: false,
          durationMs: 1,
        },
      },
    })).toBe("bash-nonzero");

    for (const kind of ["execution", "bash-timeout", "file-not-found", "webfetch-http-error"] as const) {
      const code = codeFromKind(kind);
      expect(code).toBeDefined();
      expect(kindFromCode(code ?? "")).toBe(kind);
    }
  });
});
