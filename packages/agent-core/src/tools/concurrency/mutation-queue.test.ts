import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutationQueue } from "./mutation-queue";
import type { MutationQueue } from "./mutation-queue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Access the internal queue Map for testing cleanup behavior. */
function getInternalQueue(q: MutationQueue): Map<string, Promise<unknown>> {
  return (q as unknown as { _queue: Map<string, Promise<unknown>> })._queue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MutationQueue", () => {
  test("enqueue returns the result of fn()", async () => {
    const queue = createMutationQueue();

    const result = await queue.enqueue("/tmp/test-return.txt", async () => 42);
    expect(result).toBe(42);
  });

  test("sequential operations on same file are serialized", async () => {
    const queue = createMutationQueue();
    const order: number[] = [];

    const p1 = queue.enqueue("/tmp/test-same-1.txt", async () => {
      await delay(20);
      order.push(1);
    });
    const p2 = queue.enqueue("/tmp/test-same-1.txt", async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  test("operations on different files run in parallel", async () => {
    const queue = createMutationQueue();
    const order: number[] = [];

    const p1 = queue.enqueue("/tmp/test-parallel-a.txt", async () => {
      await delay(20);
      order.push(1);
    });
    const p2 = queue.enqueue("/tmp/test-parallel-b.txt", async () => {
      await delay(5);
      order.push(2);
    });

    await Promise.all([p1, p2]);
    // p2 has shorter delay so should finish before p1
    expect(order).toEqual([2, 1]);
  });

  test("error in one operation does not block subsequent operations on same file", async () => {
    const queue = createMutationQueue();

    const p1 = queue.enqueue("/tmp/test-error.txt", async () => {
      throw new Error("first failed");
    });
    const p2 = queue.enqueue("/tmp/test-error.txt", async () => {
      return "second ok";
    });

    await expect(p1).rejects.toThrow("first failed");
    await expect(p2).resolves.toBe("second ok");
  });

  test("auto-cleanup: Map shrinks after operations complete", async () => {
    const queue = createMutationQueue();

    await queue.enqueue("/tmp/test-cleanup-1.txt", async () => "a");
    expect(getInternalQueue(queue).size).toBe(0);

    await queue.enqueue("/tmp/test-cleanup-2.txt", async () => "b");
    expect(getInternalQueue(queue).size).toBe(0);
  });

  test("auto-cleanup only removes own entry (not a newer entry)", async () => {
    const queue = createMutationQueue();
    const order: string[] = [];

    // Enqueue two operations on the same file.
    // p1 is slow, p2 runs after p1 (serialized for same file).
    const p1 = queue.enqueue("/tmp/test-own-entry.txt", async () => {
      await delay(30);
      order.push("p1-done");
    });

    const p2 = queue.enqueue("/tmp/test-own-entry.txt", async () => {
      await delay(10);
      order.push("p2-done");
    });

    // Wait for p1. After p1 resolves, its cleanup runs but p2's promise
    // is still the current entry in the map (p2 hasn't resolved yet).
    await p1;
    // p1 completes → p1's cleanup checks if it's still the current
    // entry → it's not (p2 replaced it) → p1's cleanup is a no-op.
    // p2 is still running so the map should have 1 entry.
    expect(getInternalQueue(queue).size).toBe(1);

    await p2;
    // p2 completes → p2's cleanup removes itself from the map.
    expect(getInternalQueue(queue).size).toBe(0);
    expect(order).toEqual(["p1-done", "p2-done"]);
  });

  test("proxy file paths that resolve to the same real path are serialized", async () => {
    // Create a temp dir with a symlink to verify realpath normalization.
    const dir = mkdtempSync(join(tmpdir(), "mutation-queue-"));
    const realFile = join(dir, "target.txt");
    const linkFile = join(dir, "link.txt");
    writeFileSync(realFile, "content");
    try {
      // Create symlink — use relative path for portability
      const targetRelative = "target.txt";
      const { symlinkSync } = await import("node:fs");
      symlinkSync(targetRelative, linkFile);
    } catch {
      // If symlink creation fails (e.g. permission), skip the test
      return;
    }

    const queue = createMutationQueue();
    const order: number[] = [];

    const p1 = queue.enqueue(realFile, async () => {
      await delay(20);
      order.push(1);
    });
    const p2 = queue.enqueue(linkFile, async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    // Both paths resolve to the same real path → operations are serialized
    expect(order).toEqual([1, 2]);

    // Cleanup
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates independent queue instances", () => {
    const q1 = createMutationQueue();
    const q2 = createMutationQueue();
    expect(q1).not.toBe(q2);
    // They should not share internal state
    expect(getInternalQueue(q1)).not.toBe(getInternalQueue(q2));
  });

  describe("realpath fallback for non-existent files", () => {
    test("uses original path when file does not exist", async () => {
      const queue = createMutationQueue();
      const nonExistent = "/tmp/__nonexistent_mutation_queue_test__";

      const result = await queue.enqueue(nonExistent, async () => "ok");
      expect(result).toBe("ok");
    });

    test("two identical non-existent paths are serialized", async () => {
      const queue = createMutationQueue();
      const order: number[] = [];
      const path = "/tmp/__nonexistent_mutation_queue_serial__";

      const p1 = queue.enqueue(path, async () => {
        await delay(15);
        order.push(1);
      });
      const p2 = queue.enqueue(path, async () => {
        order.push(2);
      });

      await Promise.all([p1, p2]);
      expect(order).toEqual([1, 2]);
    });
  });
});
