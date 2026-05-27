import { describe, expect, test } from "bun:test";
import { formatIsoTime } from "../format-time";

describe("formatIsoTime", () => {
  test("converts ISO timestamp to human-readable format", () => {
    expect(formatIsoTime("2025-05-27T14:30:00.123Z")).toBe("2025-05-27 14:30:00.123");
  });

  test("handles timestamp without milliseconds", () => {
    expect(formatIsoTime("2025-05-27T14:30:00Z")).toBe("2025-05-27 14:30:00");
  });

  test("handles timestamp without trailing Z", () => {
    expect(formatIsoTime("2025-05-27T14:30:00.123")).toBe("2025-05-27 14:30:00.123");
  });

  test("passes through already-formatted strings unchanged", () => {
    expect(formatIsoTime("2025-05-27 14:30:00.123")).toBe("2025-05-27 14:30:00.123");
  });

  test("works with new Date().toISOString()", () => {
    const iso = new Date().toISOString();
    const formatted = formatIsoTime(iso);
    expect(formatted).not.toContain("T");
    expect(formatted).not.toContain("Z");
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });
});