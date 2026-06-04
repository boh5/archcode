import { describe, expect, test } from "bun:test";
import { classifyLlmError } from "./classify";

describe("classifyLlmError", () => {
  test("classifies retryable errors", () => {
    expect(classifyLlmError(Object.assign(new Error("Too many requests"), { statusCode: 429 }))).toMatchObject({ kind: "rate-limit", retryable: true });
    expect(classifyLlmError({ status: 503, message: "unavailable" })).toMatchObject({ kind: "server", retryable: true, statusCode: 503 });
    expect(classifyLlmError(new Error("fetch failed: ECONNRESET"))).toMatchObject({ kind: "network", retryable: true });
    expect(classifyLlmError(new Error("unexpected EOF"))).toMatchObject({ kind: "eof", retryable: true });
    expect(classifyLlmError(new Error("SSE parse error"))).toMatchObject({ kind: "sse-parse", retryable: true });
  });

  test("classifies non-retryable errors", () => {
    expect(classifyLlmError(new DOMException("stop", "AbortError"))).toMatchObject({ kind: "abort", retryable: false });
    expect(classifyLlmError(Object.assign(new Error("Unauthorized"), { status: 401 }))).toMatchObject({ kind: "auth", retryable: false });
    expect(classifyLlmError(new Error("invalid model configuration"))).toMatchObject({ kind: "config", retryable: false });
    expect(classifyLlmError(new Error("context length exceeded"))).toMatchObject({ kind: "context-overflow", retryable: false });
    expect(classifyLlmError(new Error("surprise"))).toMatchObject({ kind: "unknown", retryable: false });
  });
});
