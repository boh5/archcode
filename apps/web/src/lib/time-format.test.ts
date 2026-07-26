import { describe, expect, test } from "bun:test";
import {
  formatCountdown,
  formatElapsedDuration,
  formatLocalDateTime,
  formatRelativeTime,
} from "./time-format";

const NOW = 2_000_000_000_000;

describe("formatRelativeTime", () => {
  test("uses the explicit now across every full-style threshold", () => {
    expect(formatRelativeTime(NOW + 5_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 9_999, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe("10s ago");
    expect(formatRelativeTime(NOW - 59_999, NOW)).toBe("59s ago");
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe("1m ago");
    expect(formatRelativeTime(NOW - 3_599_999, NOW)).toBe("59m ago");
    expect(formatRelativeTime(NOW - 3_600_000, NOW)).toBe("1h ago");
    expect(formatRelativeTime(NOW - 86_399_999, NOW)).toBe("23h ago");
    expect(formatRelativeTime(NOW - 86_400_000, NOW)).toBe("yesterday");
    expect(formatRelativeTime(NOW - 172_800_000, NOW)).toBe("2d ago");
  });

  test("preserves the short-style product language", () => {
    expect(formatRelativeTime(NOW + 1, NOW, "short")).toBe("just now");
    expect(formatRelativeTime(NOW - 59_999, NOW, "short")).toBe("just now");
    expect(formatRelativeTime(NOW - 60_000, NOW, "short")).toBe("1m");
    expect(formatRelativeTime(NOW - 3_600_000, NOW, "short")).toBe("1h");
    expect(formatRelativeTime(NOW - 86_400_000, NOW, "short")).toBe("yesterday");
    expect(formatRelativeTime(NOW - 172_800_000, NOW, "short")).toBe("2d ago");
  });

  test("rejects non-finite temporal inputs", () => {
    expect(() => formatRelativeTime(Number.NaN, NOW)).toThrow(RangeError);
    expect(() => formatRelativeTime(NOW, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("formatElapsedDuration", () => {
  test("clamps negative duration and preserves elapsed granularity", () => {
    expect(formatElapsedDuration(-1)).toBe("0s");
    expect(formatElapsedDuration(59_999)).toBe("59s");
    expect(formatElapsedDuration(65_000)).toBe("1m 5s");
    expect(formatElapsedDuration(3_599_999)).toBe("59m 59s");
    expect(formatElapsedDuration(3_600_000)).toBe("1h 0m");
    expect(formatElapsedDuration(86_465_000)).toBe("24h 1m");
  });
});

describe("formatCountdown", () => {
  test("rounds up partial seconds and stops at the target", () => {
    expect(formatCountdown(NOW + 1, NOW)).toBe("1s");
    expect(formatCountdown(NOW + 59_001, NOW)).toBe("1m 0s");
    expect(formatCountdown(NOW + 65_000, NOW)).toBe("1m 5s");
    expect(formatCountdown(NOW, NOW)).toBeNull();
    expect(formatCountdown(NOW - 1, NOW)).toBeNull();
  });
});

describe("formatLocalDateTime", () => {
  test("formats the provided timestamp without consulting the wall clock", () => {
    expect(formatLocalDateTime(0)).toBe(new Date(0).toLocaleString());
  });
});
