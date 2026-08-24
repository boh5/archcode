import { describe, expect, test } from "bun:test";

import {
  intervalFromMilliseconds,
  intervalToMilliseconds,
  isoToLocalDateTimeInput,
  minimumIntervalValue,
} from "./EditAutomationDialog";

describe("EditAutomationDialog interval controls", () => {
  test("converts readable interval units to the persisted milliseconds", () => {
    expect(intervalToMilliseconds(30, "seconds")).toBe(30_000);
    expect(intervalToMilliseconds(15, "minutes")).toBe(900_000);
    expect(intervalToMilliseconds(2, "hours")).toBe(7_200_000);
  });

  test("uses the largest exact readable unit when editing an Automation", () => {
    expect(intervalFromMilliseconds(7_200_000)).toEqual({ value: 2, unit: "hours" });
    expect(intervalFromMilliseconds(900_000)).toEqual({ value: 15, unit: "minutes" });
    expect(intervalFromMilliseconds(90_000)).toEqual({ value: 90, unit: "seconds" });
  });

  test("uses the canonical interval minimum for each displayed unit", () => {
    expect(minimumIntervalValue("seconds")).toBe(30);
    expect(minimumIntervalValue("minutes")).toBe(1);
    expect(minimumIntervalValue("hours")).toBe(1);
  });

  test("projects an ISO instant into the local datetime input", () => {
    const instant = "2026-08-03T09:30:00.000Z";
    const date = new Date(instant);
    const expected = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    expect(isoToLocalDateTimeInput(instant)).toBe(expected);
    expect(new Date(isoToLocalDateTimeInput(instant)).toISOString()).toBe(instant);
  });
});
