import type { RetryScheduler } from "../llm/retry";

export interface FakeRetryScheduler extends RetryScheduler {
  readonly sleeps: number[];
}

/** Creates an isolated deterministic scheduler that records, but never waits for, backoff. */
export function createFakeRetryScheduler(startAt = 0): FakeRetryScheduler {
  let currentTime = startAt;
  const sleeps: number[] = [];

  return {
    now: () => currentTime,
    sleeps,
    async sleep(delayMs, abortSignal): Promise<void> {
      if (abortSignal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      sleeps.push(delayMs);
      currentTime += delayMs;
    },
  };
}
