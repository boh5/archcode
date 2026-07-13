import { describe, expect, test } from "bun:test";

import {
  intervalFromMilliseconds,
  intervalToMilliseconds,
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
});
