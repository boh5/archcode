import { describe, expect, mock, test } from "bun:test";

import {
  computeDelayMs,
  parseRetryAfter,
  realRetryScheduler,
  withLlmRetry,
  type LlmRetryAuditEntry,
  type RetryScheduler,
} from "./retry";
import type { LlmRetryProfile } from "./constants";
import { LlmMaxRetriesError } from "./errors";
import { createFakeRetryScheduler } from "../testing/fake-retry-scheduler";

const noJitterProfile: LlmRetryProfile = {
  totalAttempts: 3,
  baseDelayMs: 20,
  factor: 2,
  jitterRatio: 0,
  maxDelayMs: 50,
};

describe("computeDelayMs", () => {
  test("parses Retry-After values in seconds and HTTP-date form", () => {
    const scheduler = createFakeRetryScheduler(Date.parse("2026-07-14T00:00:00.000Z"));
    expect(parseRetryAfter({ headers: { "retry-after": "0.03" } })).toBe(30);
    expect(parseRetryAfter({ retryAfterMs: 42 })).toBe(42_000);
    expect(parseRetryAfter({ retryAfter: 2_000 })).toBe(2_000);
    expect(parseRetryAfter({ headers: { "retry-after": "Tue, 14 Jul 2026 00:00:02 GMT" } }, scheduler)).toBe(2_000);
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
    const scheduler: RetryScheduler = {
      now: () => 1_000,
      sleep: async () => {
        abortController.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    };
    const operation = mock(async () => {
      throw Object.assign(new Error("rate limit"), { status: 429 });
    });

    try {
      await withLlmRetry(operation, "abortable retry", noJitterProfile, {
        abortSignal: abortController.signal,
        retryScheduler: scheduler,
      });
      expect.unreachable("expected abort during retry sleep");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    }
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test("calls onRetry before sleeping with internal audit data", async () => {
    const auditEntries: LlmRetryAuditEntry[] = [];
    const scheduler = createFakeRetryScheduler(1_000);
    const operation = mock(async () => ({ ok: true }));
    operation.mockImplementationOnce(async () => {
      throw Object.assign(new Error("server down"), { status: 500 });
    });

    const result = await withLlmRetry(operation, "audited retry", noJitterProfile, {
      onRetry: (entry) => auditEntries.push(entry),
      retryScheduler: scheduler,
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
    expect(auditEntries[0]!.nextRetryAt).toBe(1_020);
    expect(scheduler.sleeps).toEqual([20]);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("retries unknown provider-boundary errors by default", async () => {
    const scheduler = createFakeRetryScheduler(1_000);
    const operation = mock(async () => ({ ok: true }));
    operation.mockImplementationOnce(async () => {
      throw new Error("provider emitted an undocumented error");
    });

    const result = await withLlmRetry(operation, "unknown provider error", noJitterProfile, {
      retryScheduler: scheduler,
    });

    expect(result).toEqual({ ok: true });
    expect(scheduler.sleeps).toEqual([20]);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("production scheduler rejects an already-aborted sleep without waiting", async () => {
    const abortController = new AbortController();
    abortController.abort();

    try {
      await realRetryScheduler.sleep(10_000, abortController.signal);
      expect.unreachable("expected aborted sleep");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    }
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
