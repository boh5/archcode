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
    expect(classifyLlmError(Object.assign(new Error("bad prompt"), { status: 400 }))).toMatchObject({ kind: "config", retryable: false, statusCode: 400 });
    expect(classifyLlmError(Object.assign(new Error("missing model"), { status: 404 }))).toMatchObject({ kind: "config", retryable: false, statusCode: 404 });
    expect(classifyLlmError(Object.assign(new Error("request too large"), { status: 413 }))).toMatchObject({ kind: "config", retryable: false, statusCode: 413 });
    expect(classifyLlmError(Object.assign(new Error("unprocessable request"), { status: 422 }))).toMatchObject({ kind: "config", retryable: false, statusCode: 422 });
    expect(classifyLlmError(new Error("invalid model configuration"))).toMatchObject({ kind: "config", retryable: false });
    expect(classifyLlmError(new Error("context length exceeded"))).toMatchObject({ kind: "context-overflow", retryable: false });
    expect(classifyLlmError(new Error("surprise"))).toMatchObject({ kind: "unknown", retryable: false });
  });

  test("defaults unknown provider-boundary errors to retryable", () => {
    expect(classifyLlmError(new Error("surprise"), { boundary: "provider-request" })).toMatchObject({ kind: "unknown", retryable: true });
  });

  test("keeps explicit non-retryable errors terminal at provider boundary", () => {
    expect(classifyLlmError(new DOMException("stop", "AbortError"), { boundary: "provider-request" })).toMatchObject({ kind: "abort", retryable: false });
    expect(classifyLlmError(Object.assign(new Error("Unauthorized"), { status: 401 }), { boundary: "provider-request" })).toMatchObject({ kind: "auth", retryable: false });
    expect(classifyLlmError(Object.assign(new Error("bad prompt"), { status: 400 }), { boundary: "provider-request" })).toMatchObject({ kind: "config", retryable: false, statusCode: 400 });
    expect(classifyLlmError(new Error("context length exceeded"), { boundary: "provider-request" })).toMatchObject({ kind: "context-overflow", retryable: false });
  });
});
