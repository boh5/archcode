import { describe, expect, mock, test } from "bun:test";

import { computeDelayMs, parseRetryAfter, withLlmRetry, type LlmRetryAuditEntry } from "./retry";
import type { LlmRetryProfile } from "./constants";
import { LlmMaxRetriesError } from "./errors";

const noJitterProfile: LlmRetryProfile = {
  totalAttempts: 3,
  baseDelayMs: 20,
  factor: 2,
  jitterRatio: 0,
  maxDelayMs: 50,
};

describe("computeDelayMs", () => {
  test("parses Retry-After values in seconds and HTTP-date form", () => {
    expect(parseRetryAfter({ headers: { "retry-after": "0.03" } })).toBe(30);
    expect(parseRetryAfter({ retryAfterMs: 42 })).toBe(42_000);
    expect(parseRetryAfter({ retryAfter: 2_000 })).toBe(2_000);
  });
  test("caps retry-after seconds at profile maxDelayMs", () => {
    const err = Object.assign(new Error("rate limit"), { retryAfter: 999 });

    expect(computeDelayMs(1, noJitterProfile, err)).toBe(50);
  });

  test("reads retry-after from headers and respects values under cap", () => {
    const err = Object.assign(new Error("rate limit"), { headers: { "retry-after": "0.03" } });

    expect(computeDelayMs(1, noJitterProfile, err)).toBe(30);
  });
});

describe("withLlmRetry", () => {
  test("throws AbortError when abort signal fires during retry sleep", async () => {
    const abortController = new AbortController();
    const operation = mock(async () => {
      throw Object.assign(new Error("rate limit"), { status: 429 });
    });

    setTimeout(() => abortController.abort(), 10);

    try {
      await withLlmRetry(operation, "abortable retry", noJitterProfile, { abortSignal: abortController.signal });
      expect.unreachable("expected abort during retry sleep");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    }
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test("calls onRetry before sleeping with internal audit data", async () => {
    const auditEntries: LlmRetryAuditEntry[] = [];
    const operation = mock(async () => ({ ok: true }));
    operation.mockImplementationOnce(async () => {
      throw Object.assign(new Error("server down"), { status: 500 });
    });

    const before = Date.now();
    const result = await withLlmRetry(operation, "audited retry", noJitterProfile, {
      onRetry: (entry) => auditEntries.push(entry),
    });

    expect(result).toEqual({ ok: true });
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      label: "audited retry",
      attempt: 1,
      errorKind: "server",
      retryable: true,
      delayMs: 20,
    });
    expect(auditEntries[0]!.nextRetryAt).toBeGreaterThanOrEqual(before + 20);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("retries unknown provider-boundary errors by default", async () => {
    const operation = mock(async () => ({ ok: true }));
    operation.mockImplementationOnce(async () => {
      throw new Error("provider emitted an undocumented error");
    });

    const result = await withLlmRetry(operation, "unknown provider error", noJitterProfile);

    expect(result).toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("does not retry explicit non-retryable provider errors", async () => {
    const operation = mock(async () => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    });

    try {
      await withLlmRetry(operation, "auth failure", noJitterProfile);
      expect.unreachable("expected auth failure");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmMaxRetriesError);
      expect((err as LlmMaxRetriesError).attempts).toBe(1);
      expect((err as LlmMaxRetriesError).retryable).toBe(false);
    }

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
