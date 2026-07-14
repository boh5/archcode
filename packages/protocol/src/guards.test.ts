import { describe, expect, test } from "bun:test";
import { isStreamEvent, isTerminalChildSessionStatus } from "./guards";

describe("protocol event guards", () => {
  test("recognizes stream events and excludes wire-only events", () => {
    expect(isStreamEvent({ type: "text-delta", text: "ok" })).toBe(true);
    expect(isStreamEvent({ type: "shutdown" } as never)).toBe(false);
  });

  test("recognizes terminal child statuses", () => {
    expect(isTerminalChildSessionStatus("completed")).toBe(true);
    expect(isTerminalChildSessionStatus("running")).toBe(false);
    expect(isTerminalChildSessionStatus("waiting_for_human")).toBe(false);
  });
});
