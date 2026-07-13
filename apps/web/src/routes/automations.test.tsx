import { describe, expect, test } from "bun:test";
import { formatTrigger } from "./automations";

describe("Automation presentation", () => {
  test("formats each single supported trigger without legacy manual mode", () => {
    expect(formatTrigger({ kind: "once", at: "2026-07-13T00:00:00.000Z" })).toContain("Once");
    expect(formatTrigger({ kind: "interval", everyMs: 60_000 })).toBe("Every 60000 ms");
    expect(formatTrigger({ kind: "cron", expression: "*/5 * * * *", timezone: "Asia/Shanghai" }))
      .toBe("Cron */5 * * * * (Asia/Shanghai)");
  });
});
