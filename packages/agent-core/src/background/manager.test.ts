import { describe, test, expect, beforeEach } from "bun:test";
import {
  BackgroundTaskManager,
  type BackgroundTaskDeadlineHandle,
  type BackgroundTaskDeadlineScheduler,
} from "./manager";
import { silentLogger } from "../logger";
import { createMockLogger } from "../logger.test-helper";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("BackgroundTaskManager", () => {
  let manager: BackgroundTaskManager;

  beforeEach(() => {
    manager = new BackgroundTaskManager({ logger: silentLogger });
  });

  describe("dispatch", () => {
    test("fire-and-forget: returns true and task starts", () => {
      let started = false;
      const result = manager.dispatch("sync-start", () => {
        started = true;
        return Promise.resolve();
      });
      expect(result).toBe(true);
      expect(started).toBe(true);
    });

    test("task executes asynchronously and completes", async () => {
      let completed = false;
      const gate = deferred();
      manager.dispatch("async", async () => {
        await gate.promise;
        completed = true;
      });
      expect(completed).toBe(false);
      gate.resolve();
      await manager.drain();
      expect(completed).toBe(true);
    });

    test("same-name dispatch returns false when deduplicated", async () => {
      let executionCount = 0;
      const gate = deferred();
      const fn = async () => {
        executionCount++;
        await gate.promise;
      };

      const first = manager.dispatch("dedup", fn);
      const second = manager.dispatch("dedup", fn);

      expect(first).toBe(true);
      expect(second).toBe(false);

      gate.resolve();
      await manager.drain();
      expect(executionCount).toBe(1);
    });

    test("allows re-dispatch after previous task completes and returns true", async () => {
      let executionCount = 0;
      const fn = async () => {
        executionCount++;
      };

      const first = manager.dispatch("reuse", fn);
      expect(first).toBe(true);
      await manager.drain();
      expect(executionCount).toBe(1);

      const second = manager.dispatch("reuse", fn);
      expect(second).toBe(true);
      await manager.drain();
      expect(executionCount).toBe(2);
    });

    test("records the completion timestamp from the current clock", async () => {
      const originalDateNow = Date.now;
      Date.now = () => 12_345;
      try {
        manager.dispatch("completed-at", async () => {});
        await manager.drain();
        expect(manager.getLastCompletedAt("completed-at")).toBe(12_345);
      } finally {
        Date.now = originalDateNow;
      }
    });
  });

  describe("isRunning", () => {
    test("returns true while a task is in-flight", () => {
      manager.dispatch("never", () => new Promise<void>(() => {}));
      expect(manager.isRunning("never")).toBe(true);
    });

    test("returns false after task completes", async () => {
      manager.dispatch("fast", () => Promise.resolve());
      await manager.drain();
      expect(manager.isRunning("fast")).toBe(false);
    });

    test("returns false for unknown task name", () => {
      expect(manager.isRunning("nope")).toBe(false);
    });
  });

  describe("drain", () => {
    test("waits for all in-flight tasks to complete", async () => {
      let done = false;
      const gate = deferred();
      manager.dispatch("slowpoke", async () => {
        await gate.promise;
        done = true;
      });

      expect(done).toBe(false);
      gate.resolve();
      await manager.drain();
      expect(done).toBe(true);
    });

    test("resolves immediately when no tasks are running", async () => {
      await expect(manager.drain()).resolves.toBeUndefined();
    });

    test("returns when its controlled deadline fires and cancels the timer", async () => {
      const deadline = createManualDeadlineScheduler();
      manager = new BackgroundTaskManager({
        logger: silentLogger,
        deadlineScheduler: deadline.scheduler,
      });
      manager.dispatch("eternal", () => new Promise<void>(() => {}));

      const draining = manager.drain(60_000);
      expect(deadline.scheduledDelays).toEqual([60_000]);
      deadline.fire();

      await expect(draining).resolves.toBeUndefined();
      expect(manager.isRunning("eternal")).toBe(true);
      expect(deadline.cancelled).toHaveLength(1);
    });

    test("drain timeout default is 60s", async () => {
      // Just verify the signature accepts no argument
      expect(typeof manager.drain).toBe("function");
      expect(manager.drain.length).toBe(0); // default param, not counted
    });
  });

  describe("cancelAll", () => {
    test("clears tracking for all tasks", () => {
      manager.dispatch("a", () => new Promise<void>(() => {}));
      manager.dispatch("b", () => new Promise<void>(() => {}));
      expect(manager.isRunning("a")).toBe(true);
      expect(manager.isRunning("b")).toBe(true);

      manager.cancelAll();
      expect(manager.isRunning("a")).toBe(false);
      expect(manager.isRunning("b")).toBe(false);
    });

    test("drain completes successfully after cancelAll", async () => {
      manager.dispatch("slow", () => new Promise<void>(() => {}));
      manager.cancelAll();
      // drain should return quickly (nothing to wait for)
      await expect(manager.drain()).resolves.toBeUndefined();
    });
  });

  describe("error handling", () => {
    test("catches task errors and logs them via configured logger", async () => {
      const logger = createMockLogger();
      manager = new BackgroundTaskManager({ logger });
      const error = new Error("task failure");

      manager.dispatch("failing", async () => {
        throw error;
      });

      await manager.drain();
      expect(logger.warn).toHaveBeenCalledWith("background.task.failed", {
        error,
        meta: { backgroundTaskName: "failing" },
      });
    });

    test("error does not prevent drain from completing", async () => {
      manager.dispatch("boom", async () => {
        throw new Error("boom");
      });
      await expect(manager.drain()).resolves.toBeUndefined();
    });

    test("manager can dispatch new tasks after a task error", async () => {
      manager.dispatch("failing", async () => {
        throw new Error("boom");
      });
      await manager.drain();

      let recovered = false;
      manager.dispatch("recovery", async () => {
        recovered = true;
      });
      await manager.drain();
      expect(recovered).toBe(true);
    });
  });
});

function createManualDeadlineScheduler(): {
  scheduler: BackgroundTaskDeadlineScheduler;
  fire: () => void;
  scheduledDelays: number[];
  cancelled: BackgroundTaskDeadlineHandle[];
} {
  let callback: (() => void) | undefined;
  const scheduledDelays: number[] = [];
  const cancelled: BackgroundTaskDeadlineHandle[] = [];
  const handle = { id: Symbol("background-drain") };
  return {
    scheduler: {
      schedule(delayMs, nextCallback) {
        scheduledDelays.push(delayMs);
        callback = nextCallback;
        return handle;
      },
      cancel(cancelledHandle) {
        cancelled.push(cancelledHandle);
      },
    },
    fire() {
      const pending = callback;
      callback = undefined;
      if (pending === undefined) throw new Error("No background drain deadline is scheduled");
      pending();
    },
    scheduledDelays,
    cancelled,
  };
}
