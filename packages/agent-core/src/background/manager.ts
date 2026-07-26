/**
 * Fire-and-forget background task manager.
 *
 * Tracks in-flight tasks by name, deduplicates concurrent dispatches of the
 * same task, and provides drain / cancel hooks for lifecycle management.
 */
import type { Logger } from "../logger";

export interface BackgroundTaskManagerOptions {
  readonly logger: Logger;
  readonly deadlineScheduler?: BackgroundTaskDeadlineScheduler;
}

export interface BackgroundTaskDeadlineHandle {
  readonly id?: unknown;
}

export interface BackgroundTaskDeadlineScheduler {
  schedule(delayMs: number, callback: () => void): BackgroundTaskDeadlineHandle;
  cancel(handle: BackgroundTaskDeadlineHandle): void;
}

const systemBackgroundTaskDeadlineScheduler: BackgroundTaskDeadlineScheduler = {
  schedule: (delayMs, callback) => {
    const id = setTimeout(callback, delayMs);
    if (typeof id === "object" && "unref" in id) id.unref();
    return { id };
  },
  cancel: (handle) => {
    if (handle.id !== undefined) clearTimeout(handle.id as Timer);
  },
};

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly lastCompletedAt = new Map<string, number>();
  private readonly logger: Logger;
  private readonly deadlineScheduler: BackgroundTaskDeadlineScheduler;

  constructor(options: BackgroundTaskManagerOptions) {
    this.logger = options.logger;
    this.deadlineScheduler = options.deadlineScheduler ?? systemBackgroundTaskDeadlineScheduler;
  }

  /**
   * Dispatch a background task. Returns `true` if the task was accepted,
   * `false` if a same-name task is already in-flight (dedup).
   *
   * The task runs asynchronously. Task errors are caught and logged via
   * the configured logger; they never propagate to the caller or crash the main loop.
   */
  dispatch(name: string, task: () => Promise<void>): boolean {
    if (this.tasks.has(name)) return false;

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
        this.logger.warn("background.task.failed", {
          error: err,
          meta: { backgroundTaskName: name },
        });
        entry.resolve(); // Error caught — resolve wrapper so drain doesn't hang
      })
      .finally(() => {
        this.lastCompletedAt.set(name, Date.now());
        this.tasks.delete(name);
      });

    return true;
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
    let deadline: BackgroundTaskDeadlineHandle | undefined;
    const timeout = new Promise<void>((_resolve, reject) => {
      deadline = this.deadlineScheduler.schedule(
        timeoutMs,
        () => reject(new Error(`Drain timed out after ${timeoutMs}ms`)),
      );
    });

    try {
      await Promise.race([Promise.allSettled(promises), timeout]).catch(() => {
        /* timeout reached — drain returns regardless */
      });
    } finally {
      if (deadline !== undefined) this.deadlineScheduler.cancel(deadline);
    }
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

  getLastCompletedAt(name: string): number | undefined {
    return this.lastCompletedAt.get(name);
  }
}

interface TaskEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  promise: Promise<void>;
}
