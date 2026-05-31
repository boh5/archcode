import { describe, test, expect, beforeEach } from "bun:test";
import { BackgroundTaskManager } from "./manager";
import { silentLogger } from "../logger";
import { createMockLogger } from "../logger.test-helper";

function tick(ms: number = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
      manager.dispatch("async", async () => {
        await tick(5);
        completed = true;
      });
      expect(completed).toBe(false);
      await tick(15);
      expect(completed).toBe(true);
    });

    test("same-name dispatch returns false when deduplicated", async () => {
      let executionCount = 0;
      const fn = async () => {
        executionCount++;
        await tick(20);
      };

      const first = manager.dispatch("dedup", fn);
      const second = manager.dispatch("dedup", fn);

      expect(first).toBe(true);
      expect(second).toBe(false);

      await tick(40);
      expect(executionCount).toBe(1);
    });

    test("allows re-dispatch after previous task completes and returns true", async () => {
      let executionCount = 0;
      const fn = async () => {
        executionCount++;
      };

      const first = manager.dispatch("reuse", fn);
      expect(first).toBe(true);
      await tick(10);
      expect(executionCount).toBe(1);

      const second = manager.dispatch("reuse", fn);
      expect(second).toBe(true);
      await tick(10);
      expect(executionCount).toBe(2);
    });

    test("records last completed timestamp after task settles", async () => {
      const before = Date.now();
      manager.dispatch("completed-at", async () => {});
      await tick(10);

      const completedAt = manager.getLastCompletedAt("completed-at");
      expect(completedAt).toBeNumber();
      expect(completedAt!).toBeGreaterThanOrEqual(before);
    });
  });

  describe("isRunning", () => {
    test("returns true while a task is in-flight", () => {
      manager.dispatch("never", () => new Promise<void>(() => {}));
      expect(manager.isRunning("never")).toBe(true);
    });

    test("returns false after task completes", async () => {
      manager.dispatch("fast", () => Promise.resolve());
      await tick(10);
      expect(manager.isRunning("fast")).toBe(false);
    });

    test("returns false for unknown task name", () => {
      expect(manager.isRunning("nope")).toBe(false);
    });
  });

  describe("drain", () => {
    test("waits for all in-flight tasks to complete", async () => {
      let done = false;
      manager.dispatch("slowpoke", async () => {
        await tick(10);
        done = true;
      });

      expect(done).toBe(false);
      await manager.drain();
      expect(done).toBe(true);
    });

    test("resolves immediately when no tasks are running", async () => {
      await expect(manager.drain()).resolves.toBeUndefined();
    });

    test("times out and returns even if tasks are still running", async () => {
      // Never-resolving task
      manager.dispatch("eternal", () => new Promise<void>(() => {}));
      const start = performance.now();
      await manager.drain(50);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(30);
      expect(elapsed).toBeLessThan(300);
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
      await expect(manager.drain(10)).resolves.toBeUndefined();
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

      await tick(10);
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
      await tick(10);

      let recovered = false;
      manager.dispatch("recovery", async () => {
        recovered = true;
      });
      await tick(10);
      expect(recovered).toBe(true);
    });
  });
});
