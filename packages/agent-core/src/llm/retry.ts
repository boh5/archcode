import { LLM_SHORT_RETRY_PROFILE, type LlmRetryProfile } from "./constants";
import { LlmMaxRetriesError } from "./errors";
import { classifyLlmError } from "./classify";
import { sanitizeProviderError, type SensitiveTextRedactor } from "./provider-error-sanitizer";

export interface LlmRetryAuditEntry {
  readonly label: string;
  readonly attempt: number;
  readonly errorKind: string;
  readonly retryable: boolean;
  readonly delayMs: number;
  readonly nextRetryAt: number;
}

export interface RetryScheduler {
  readonly now: () => number;
  readonly sleep: (delayMs: number, abortSignal?: AbortSignal) => Promise<void>;
}

export const realRetryScheduler: RetryScheduler = Object.freeze({
  now: () => Date.now(),
  sleep: sleepAbortable,
});

export async function withLlmRetry<T>(
  operation: () => Promise<T>,
  label: string,
  profile: LlmRetryProfile = LLM_SHORT_RETRY_PROFILE,
  options?: {
    abortSignal?: AbortSignal;
    onRetry?: (entry: LlmRetryAuditEntry) => void;
    retryScheduler?: RetryScheduler;
    redactSensitiveText?: SensitiveTextRedactor;
  },
): Promise<T> {
  const retryScheduler = options?.retryScheduler ?? realRetryScheduler;
  let lastError: unknown;
  let lastRetryable = false;

  for (let attempt = 1; attempt <= profile.totalAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const classification = classifyLlmError(err, { boundary: "provider-request" });
      const safeError = options?.redactSensitiveText
        ? sanitizeProviderError(err, options.redactSensitiveText)
        : err;
      lastError = safeError;
      lastRetryable = classification.retryable;
      if (!classification.retryable || attempt >= profile.totalAttempts) {
        throw new LlmMaxRetriesError({
          message: `${label} failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${safeError instanceof Error ? safeError.message : String(safeError)}`,
          cause: safeError instanceof Error ? safeError : undefined,
          attempts: attempt,
          retryable: classification.retryable,
        });
      }
      const delayMs = computeDelayMs(attempt, profile, err, retryScheduler);
      options?.onRetry?.({
        label,
        attempt,
        errorKind: classification.kind,
        retryable: classification.retryable,
        delayMs,
        nextRetryAt: retryScheduler.now() + delayMs,
      });
      await retryScheduler.sleep(delayMs, options?.abortSignal);
      if (options?.abortSignal?.aborted) throw createAbortError();
    }
  }

  throw new LlmMaxRetriesError({
    message: `${label} failed after ${profile.totalAttempts} attempts`,
    cause: lastError instanceof Error ? lastError : undefined,
    attempts: profile.totalAttempts,
    retryable: lastRetryable,
  });
}

export function computeDelayMs(
  failedAttempt: number,
  profile: LlmRetryProfile = LLM_SHORT_RETRY_PROFILE,
  error?: unknown,
  retryScheduler: Pick<RetryScheduler, "now"> = realRetryScheduler,
): number {
  const retryAfterMs = parseRetryAfter(error, retryScheduler);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, profile.maxDelayMs);
  const exponential = profile.baseDelayMs * profile.factor ** Math.max(0, failedAttempt - 1);
  const capped = Math.min(exponential, profile.maxDelayMs);
  const jitter = capped * profile.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export function parseRetryAfter(
  error: unknown,
  retryScheduler: Pick<RetryScheduler, "now"> = realRetryScheduler,
): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const headers = record.headers;
  const candidates = [record.retryAfter, record.retryAfterMs];
  if (headers && typeof headers === "object") {
    const headerRecord = headers as Record<string, unknown> & { get?: (name: string) => unknown };
    candidates.push(headerRecord["retry-after"], headerRecord["Retry-After"], headerRecord.get?.("retry-after"));
  }

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate > 1_000 ? candidate : candidate * 1_000;
    }
    if (typeof candidate === "string") {
      const seconds = Number(candidate);
      if (Number.isFinite(seconds)) return seconds * 1_000;
      const dateMs = Date.parse(candidate);
      if (Number.isFinite(dateMs)) return Math.max(0, dateMs - retryScheduler.now());
    }
  }

  return undefined;
}

async function sleepAbortable(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) throw createAbortError();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => settle(resolve), ms);
    const onAbort = () => settle(() => reject(createAbortError()));

    function settle(finish: () => void) {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
      finish();
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}
