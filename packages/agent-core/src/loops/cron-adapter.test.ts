import { describe, expect, test } from "bun:test";

import { BunCronAdapter, FakeCronAdapter, runBunCronCallbackForTest } from "./cron-adapter";

describe("CronAdapter", () => {
  test("validates 5-field UTC cron and computes next fire", () => {
    const adapter = new BunCronAdapter();
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);

    const result = adapter.validate("*/15 * * * *", from);

    expect(result).toEqual({ valid: true, nextFireAt: Date.UTC(2026, 0, 1, 0, 15, 0) });
    expect(adapter.nextFire("*/15 * * * *", from)).toBe(Date.UTC(2026, 0, 1, 0, 15, 0));
  });

  test("rejects six-field seconds cron expressions before registration", () => {
    const adapter = new BunCronAdapter();

    const result = adapter.validate("*/15 * * * * *", Date.UTC(2026, 0, 1, 0, 0, 0));

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/5 UTC fields/i);
  });

  test("rejects impossible cron dates with no future occurrence", () => {
    const adapter = new BunCronAdapter();

    const result = adapter.validate("0 0 30 2 *", Date.UTC(2026, 0, 1, 0, 0, 0));

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no future UTC occurrence/i);
  });

  test("fake adapter registers deterministic handles and fires callbacks manually", async () => {
    const adapter = new FakeCronAdapter();
    const fired: number[] = [];
    const handle = adapter.schedule("*/15 * * * *", (scheduledAt) => {
      fired.push(scheduledAt);
    });

    await adapter.fire(handle, Date.UTC(2026, 0, 1, 0, 15, 0));

    expect(fired).toEqual([Date.UTC(2026, 0, 1, 0, 15, 0)]);
    expect(adapter.size()).toBe(1);
    adapter.cancel(handle);
    expect(adapter.size()).toBe(0);
  });

  test("production cron callback uses Bun scheduledTime and catches rejections", async () => {
    const scheduledAt = Date.UTC(2026, 0, 1, 0, 15, 0);
    const received: number[] = [];

    await runBunCronCallbackForTest({ scheduledTime: scheduledAt }, (value) => {
      received.push(value);
    });
    await runBunCronCallbackForTest({ scheduledTime: scheduledAt + 1 }, () => {
      throw new Error("scheduler records this separately");
    });

    expect(received).toEqual([scheduledAt]);
  });
});
