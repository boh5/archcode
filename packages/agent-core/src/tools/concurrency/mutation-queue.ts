import { realpathSync } from "node:fs";

export interface MutationQueue {
  /**
   * Enqueue a mutation operation for a file path.
   * Operations on the same file are serialized;
   * operations on different files run in parallel.
   * Returns the result of fn().
   */
  enqueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>;
}

export function createMutationQueue(): MutationQueue {
  const _queue = new Map<string, Promise<unknown>>();

  function resolveKey(filePath: string): string {
    try {
      return realpathSync.native(filePath);
    } catch {
      return filePath;
    }
  }

  const api = {
    enqueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
      const key = resolveKey(filePath);
      const prev = _queue.get(key) ?? Promise.resolve();

      // Two-argument then() so a rejected prev doesn't block fn from running
      const next = prev.then(
        () => fn(),
        () => fn(),
      );

      // Auto-cleanup: remove from map only if we're still the current entry
      const cleanup = () => {
        if (_queue.get(key) === next) {
          _queue.delete(key);
        }
      };
      next.then(cleanup, cleanup);

      _queue.set(key, next);
      return next;
    },

    // Exposed for testing — not part of the MutationQueue interface
    _queue,
  };

  return api;
}

/**
 * Shared singleton mutation queue used by all builtin tools.
 * Ensures that file_write and file_edit operations on the same file
 * are serialized even across different tools.
 */
export const sharedMutationQueue = createMutationQueue();
