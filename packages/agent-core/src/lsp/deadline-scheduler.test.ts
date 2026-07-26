import { describe, expect, test } from "bun:test";
import {
  raceLspDeadline,
  type LspDeadlineHandle,
  type LspDeadlineScheduler,
} from "./deadline-scheduler";

describe("raceLspDeadline", () => {
  test("rejects only when the controlled deadline fires and cancels its handle", async () => {
    let fire!: () => void;
    const cancelled: LspDeadlineHandle[] = [];
    const scheduler: LspDeadlineScheduler = {
      schedule(delayMs, callback) {
        expect(delayMs).toBe(10_000);
        fire = callback;
        return { id: "deadline" };
      },
      cancel(handle) {
        cancelled.push(handle);
      },
      async sleep() {},
    };

    const pending = raceLspDeadline(
      new Promise<never>(() => {}),
      10_000,
      () => new Error("controlled timeout"),
      scheduler,
    );
    fire();

    await expect(pending).rejects.toThrow("controlled timeout");
    expect(cancelled).toEqual([{ id: "deadline" }]);
  });

  test("returns the operation result and cancels the unused deadline", async () => {
    const cancelled: LspDeadlineHandle[] = [];
    const scheduler: LspDeadlineScheduler = {
      schedule: () => ({ id: "deadline" }),
      cancel(handle) {
        cancelled.push(handle);
      },
      async sleep() {},
    };

    await expect(raceLspDeadline(
      Promise.resolve("ready"),
      10_000,
      () => new Error("unused"),
      scheduler,
    )).resolves.toBe("ready");
    expect(cancelled).toEqual([{ id: "deadline" }]);
  });
});
