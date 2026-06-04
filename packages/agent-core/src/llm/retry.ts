import { LLM_SHORT_RETRY_PROFILE, type LlmRetryProfile } from "./constants";
import { LlmMaxRetriesError } from "./errors";
import { classifyLlmError } from "./classify";

export async function withLlmRetry<T>(operation: () => Promise<T>, label: string, profile: LlmRetryProfile = LLM_SHORT_RETRY_PROFILE): Promise<T> {
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
      await sleep(computeDelayMs(attempt, profile));
    }
  }

  throw new LlmMaxRetriesError({
    message: `${label} failed after ${profile.totalAttempts} attempts`,
    cause: lastError instanceof Error ? lastError : undefined,
    attempts: profile.totalAttempts,
    retryable: lastRetryable,
  });
}

export function computeDelayMs(failedAttempt: number, profile: LlmRetryProfile = LLM_SHORT_RETRY_PROFILE): number {
  const exponential = profile.baseDelayMs * profile.factor ** Math.max(0, failedAttempt - 1);
  const capped = Math.min(exponential, profile.maxDelayMs);
  const jitter = capped * profile.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
