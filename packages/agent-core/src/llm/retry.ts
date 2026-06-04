import { LLM_SHORT_RETRY_PROFILE, type LlmRetryProfile } from "./constants";
import { LlmMaxRetriesError } from "./errors";
import { classifyLlmError } from "./classify";

export interface LlmRetryAuditEntry {
  readonly label: string;
  readonly attempt: number;
  readonly errorKind: string;
  readonly retryable: boolean;
  readonly delayMs: number;
  readonly nextRetryAt: number;
}

export async function withLlmRetry<T>(
  operation: () => Promise<T>,
  label: string,
  profile: LlmRetryProfile = LLM_SHORT_RETRY_PROFILE,
  options?: { abortSignal?: AbortSignal; onRetry?: (entry: LlmRetryAuditEntry) => void },
): Promise<T> {
  let lastError: unknown;
  let lastRetryable = false;

  for (let attempt = 1; attempt <= profile.totalAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const classification = classifyLlmError(err);
      lastRetryable = classification.retryable;
      if (!classification.retryable || attempt >= profile.totalAttempts) {
        throw new LlmMaxRetriesError({
          message: `${label} failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${err instanceof Error ? err.message : String(err)}`,
          cause: err instanceof Error ? err : undefined,
          attempts: attempt,
          retryable: classification.retryable,
        });
      }
      const delayMs = computeDelayMs(attempt, profile, err);
      options?.onRetry?.({
        label,
        attempt,
        errorKind: classification.kind,
        retryable: classification.retryable,
        delayMs,
        nextRetryAt: Date.now() + delayMs,
      });
      await sleep(delayMs, options?.abortSignal);
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

export function computeDelayMs(failedAttempt: number, profile: LlmRetryProfile = LLM_SHORT_RETRY_PROFILE, error?: unknown): number {
  const retryAfterMs = getRetryAfterMs(error);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, profile.maxDelayMs);
  const exponential = profile.baseDelayMs * profile.factor ** Math.max(0, failedAttempt - 1);
  const capped = Math.min(exponential, profile.maxDelayMs);
  const jitter = capped * profile.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

function getRetryAfterMs(error: unknown): number | undefined {
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
      if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
    }
  }

  return undefined;
}

async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0 || abortSignal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", done);
      resolve();
    }
    abortSignal?.addEventListener("abort", done, { once: true });
  });
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}
