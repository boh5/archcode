/**
 * Fire-and-forget background task manager.
 *
 * Tracks in-flight tasks by name, deduplicates concurrent dispatches of the
 * same task, and provides drain / cancel hooks for lifecycle management.
 */
export class BackgroundTaskManager {
  private readonly tasks = new Map<string, TaskEntry>();

  /**
   * Dispatch a background task. Returns immediately — the task runs
   * asynchronously. If a task with the same name is already in-flight,
   * this second dispatch is silently skipped (dedup).
   *
   * Task errors are caught and logged via `console.warn`; they never
   * propagate to the caller or crash the main loop.
   */
  dispatch(name: string, task: () => Promise<void>): void {
    if (this.tasks.has(name)) return;

    let resolve: () => void;
    let reject: (err: Error) => void;
    const wrapper = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry: TaskEntry = { resolve: resolve!, reject: reject!, promise: wrapper };
    this.tasks.set(name, entry);

    // Swallow rejections triggered by cancelAll() — drain() uses allSettled
    // which already accounts for rejected promises.
    void entry.promise.catch(() => {});

    void task()
      .then(() => entry.resolve())
      .catch((err: unknown) => {
        console.warn(`[BackgroundTaskManager] Task "${name}" failed:`, err);
        entry.resolve(); // Error caught — resolve wrapper so drain doesn't hang
      })
      .finally(() => {
        this.tasks.delete(name);
      });
  }

  /**
   * Wait for all in-flight tasks to settle (resolve or reject).
   *
   * @param timeoutMs Maximum time to wait in milliseconds (default: 60000).
   *   Returns when the timeout fires even if tasks are still running.
   */
  async drain(timeoutMs: number = 60000): Promise<void> {
    if (this.tasks.size === 0) return;

    const promises = Array.from(this.tasks.values()).map((e) => e.promise);
    const timeout = new Promise<void>((_resolve, reject) => {
      const id = setTimeout(() => reject(new Error(`Drain timed out after ${timeoutMs}ms`)), timeoutMs);
      // Allow the timer to be released if all tasks finish first
      if (typeof id === "object" && "unref" in id) (id as { unref: () => void }).unref();
    });

    await Promise.race([Promise.allSettled(promises), timeout]).catch(() => {
      /* timeout reached — drain returns regardless */
    });
  }

  /**
   * Cancel all in-flight tasks and clear tracking state.
   *
   * All tracked task promises are rejected. Tasks that were already running
   * will still execute to completion in the background but are no longer
   * tracked by this manager.
   */
  cancelAll(): void {
    for (const [name, entry] of this.tasks) {
      entry.reject(new Error(`Background task "${name}" cancelled`));
    }
    this.tasks.clear();
  }

  /**
   * Check whether a task with the given name is currently running.
   */
  isRunning(name: string): boolean {
    return this.tasks.has(name);
  }
}

interface TaskEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  promise: Promise<void>;
}
