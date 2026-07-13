import { describe, expect, test } from "bun:test";

import { nextFireAt, validateAutomationTrigger } from "./schedule";

describe("automation schedules", () => {
  test("computes once and interval occurrences strictly after now", () => {
    const now = Date.parse("2026-07-13T00:00:00.000Z");
    expect(nextFireAt({ kind: "once", at: "2026-07-13T00:00:01.000Z" }, now)).toBe("2026-07-13T00:00:01.000Z");
    expect(nextFireAt({ kind: "once", at: "2026-07-13T00:00:00.000Z" }, now)).toBeUndefined();
    expect(nextFireAt({ kind: "interval", everyMs: 30_000 }, now)).toBe("2026-07-13T00:00:30.000Z");
  });

  test("evaluates cron in an IANA timezone across DST", () => {
    const beforeSpringForward = Date.parse("2026-03-08T06:59:00.000Z");
    expect(nextFireAt({ kind: "cron", expression: "30 2 * * *", timezone: "America/New_York" }, beforeSpringForward))
      .toBe("2026-03-09T06:30:00.000Z");

    const beforeRepeatedHour = Date.parse("2026-11-01T04:59:00.000Z");
    expect(nextFireAt({ kind: "cron", expression: "30 1 * * *", timezone: "America/New_York" }, beforeRepeatedHour))
      .toBe("2026-11-01T05:30:00.000Z");
  });

  test("rejects invalid intervals, cron syntax, and timezones", () => {
    expect(() => validateAutomationTrigger({ kind: "interval", everyMs: 29_999 })).toThrow();
    expect(() => validateAutomationTrigger({ kind: "cron", expression: "0 0 * *", timezone: "UTC" })).toThrow();
    expect(() => validateAutomationTrigger({ kind: "cron", expression: "61 * * * *", timezone: "UTC" })).toThrow();
    expect(() => validateAutomationTrigger({ kind: "cron", expression: "0 0 * * *", timezone: "Mars/Olympus" })).toThrow();
  });
});
