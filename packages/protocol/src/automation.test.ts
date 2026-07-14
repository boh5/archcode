import { describe, expect, test } from "bun:test";

import {
  AUTOMATION_MESSAGE_MAX_LENGTH,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_TIMEZONE_MAX_LENGTH,
  MIN_AUTOMATION_INTERVAL_MS,
} from "./automation";

describe("automation contract constants", () => {
  test("exports the cross-layer input limits", () => {
    expect(AUTOMATION_NAME_MAX_LENGTH).toBe(200);
    expect(AUTOMATION_MESSAGE_MAX_LENGTH).toBe(10_000);
    expect(AUTOMATION_TIMEZONE_MAX_LENGTH).toBe(100);
    expect(MIN_AUTOMATION_INTERVAL_MS).toBe(30_000);
  });
});
