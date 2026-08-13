import { describe, expect, test } from "bun:test";
import { formatAutomationScheduleTime, formatAutomationTrigger } from "../lib/automation-trigger-presentation";

describe("Automation presentation", () => {
  test("formats every supported trigger", () => {
    expect(formatAutomationTrigger({ kind: "once", at: "2026-07-13T00:00:00.000Z" })).toContain("Once");
    expect(formatAutomationTrigger({ kind: "interval", everyMs: 60_000 })).toBe("Every 60000 ms");
    expect(formatAutomationTrigger({ kind: "cron", expression: "*/5 * * * *", timezone: "Asia/Shanghai" }))
      .toBe("Cron */5 * * * * (Asia/Shanghai)");
  });

  test("formats upcoming schedule timestamps as compact human time", () => {
    const now = new Date(2026, 7, 13, 8, 0).getTime();
    expect(formatAutomationScheduleTime(new Date(2026, 7, 13, 9, 0).toISOString(), now)).toContain("Today");
    expect(formatAutomationScheduleTime(new Date(2026, 7, 14, 9, 0).toISOString(), now)).toContain("Tomorrow");
    expect(formatAutomationScheduleTime(new Date(2026, 7, 17, 9, 0).toISOString(), now)).toContain("Monday");
  });
});
