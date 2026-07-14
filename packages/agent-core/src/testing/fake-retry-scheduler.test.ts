import { describe, expect, test } from "bun:test";
import { createFakeRetryScheduler } from "./fake-retry-scheduler";

describe("createFakeRetryScheduler", () => {
  test("advances deterministic time without a wall-clock delay", async () => {
    const scheduler = createFakeRetryScheduler(100);

    await scheduler.sleep(250);

    expect(scheduler.now()).toBe(350);
    expect(scheduler.sleeps).toEqual([250]);
  });

  test("honors an already-aborted signal", async () => {
    const scheduler = createFakeRetryScheduler();
    const controller = new AbortController();
    controller.abort();

    expect(scheduler.sleep(250, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.sleeps).toEqual([]);
  });
});
