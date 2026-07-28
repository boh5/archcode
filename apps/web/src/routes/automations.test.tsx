import { describe, expect, test } from "bun:test";
import { formatAutomationTrigger } from "../lib/automation-trigger-presentation";

describe("Automation presentation", () => {
  test("formats every supported trigger", () => {
    expect(formatAutomationTrigger({ kind: "once", at: "2026-07-13T00:00:00.000Z" })).toContain("Once");
    expect(formatAutomationTrigger({ kind: "interval", everyMs: 60_000 })).toBe("Every 60000 ms");
    expect(formatAutomationTrigger({ kind: "cron", expression: "*/5 * * * *", timezone: "Asia/Shanghai" }))
      .toBe("Cron */5 * * * * (Asia/Shanghai)");
  });
});
