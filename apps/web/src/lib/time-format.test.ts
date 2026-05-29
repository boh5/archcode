import { describe, expect, test } from "bun:test";
import { formatRelativeTime, formatShortRelativeTime, formatElapsed } from "./time-format";

describe("formatRelativeTime", () => {
  test("returns 'just now' for <10 seconds", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 5000)).toBe("just now");
    expect(formatRelativeTime(now - 0)).toBe("just now");
  });

  test("returns seconds for <60 seconds", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 30_000)).toBe("30s ago");
    expect(formatRelativeTime(now - 59_000)).toBe("59s ago");
  });

  test("returns minutes for <60 minutes", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 120_000)).toBe("2m ago");
    expect(formatRelativeTime(now - 3_540_000)).toBe("59m ago");
  });

  test("returns hours for <24 hours", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 3_600_000)).toBe("1h ago");
    expect(formatRelativeTime(now - 83_400_000)).toBe("23h ago");
  });

  test("returns 'yesterday' for 1 day ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 86_400_000)).toBe("yesterday");
  });

  test("returns days for >1 day", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 172_800_000)).toBe("2d ago");
    expect(formatRelativeTime(now - 604_800_000)).toBe("7d ago");
  });
});

describe("formatShortRelativeTime", () => {
  test("returns 'just now' for <60 seconds", () => {
    const now = Date.now();
    expect(formatShortRelativeTime(now - 5_000)).toBe("just now");
    expect(formatShortRelativeTime(now - 59_000)).toBe("just now");
  });

  test("returns minutes without 'ago'", () => {
    const now = Date.now();
    expect(formatShortRelativeTime(now - 120_000)).toBe("2m");
    expect(formatShortRelativeTime(now - 59 * 60_000)).toBe("59m");
  });

  test("returns hours without 'ago'", () => {
    const now = Date.now();
    expect(formatShortRelativeTime(now - 3_600_000)).toBe("1h");
    expect(formatShortRelativeTime(now - 23 * 3_600_000)).toBe("23h");
  });

  test("returns 'yesterday' for 1 day", () => {
    const now = Date.now();
    expect(formatShortRelativeTime(now - 86_400_000)).toBe("yesterday");
  });

  test("returns days with 'ago'", () => {
    const now = Date.now();
    expect(formatShortRelativeTime(now - 172_800_000)).toBe("2d ago");
  });
});

describe("formatElapsed", () => {
  test("returns seconds for <60 seconds", () => {
    const now = Date.now();
    expect(formatElapsed(now - 5_000)).toBe("5s");
    expect(formatElapsed(now - 0)).toBe("0s");
    expect(formatElapsed(now - 59_000)).toBe("59s");
  });

  test("returns minutes and seconds for <60 minutes", () => {
    const now = Date.now();
    expect(formatElapsed(now - 65_000)).toBe("1m 5s");
    expect(formatElapsed(now - 125_000)).toBe("2m 5s");
    expect(formatElapsed(now - 3_599_000)).toBe("59m 59s");
  });

  test("returns hours and minutes for >=60 minutes", () => {
    const now = Date.now();
    expect(formatElapsed(now - 3_600_000)).toBe("1h 0m");
    expect(formatElapsed(now - 3_665_000)).toBe("1h 1m");
    expect(formatElapsed(now - 86_400_000)).toBe("24h 0m");
  });
});