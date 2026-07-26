export interface LspDeadlineHandle {
  readonly id?: unknown;
}

/**
 * Owns LSP deadlines and retry delays independently from protocol and process I/O.
 */
export interface LspDeadlineScheduler {
  schedule(delayMs: number, callback: () => void): LspDeadlineHandle;
  cancel(handle: LspDeadlineHandle): void;
  sleep(delayMs: number): Promise<void>;
}

export const systemLspDeadlineScheduler: LspDeadlineScheduler = {
  schedule: (delayMs, callback) => {
    const id = setTimeout(callback, delayMs);
    return { id };
  },
  cancel: (handle) => {
    if (handle.id !== undefined) clearTimeout(handle.id as Timer);
  },
  sleep: async (delayMs) => {
    await Bun.sleep(delayMs);
  },
};

export async function raceLspDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createTimeoutError: () => Error,
  scheduler: LspDeadlineScheduler,
): Promise<T> {
  let handle: LspDeadlineHandle | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = scheduler.schedule(timeoutMs, () => reject(createTimeoutError()));
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle !== undefined) scheduler.cancel(handle);
  }
}
