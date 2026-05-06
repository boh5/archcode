import { describe, expect, test } from "bun:test";
import { BusyError } from "./types";

describe("BusyError", () => {
  test("has correct name property", () => {
    const error = new BusyError("test-session");
    expect(error.name).toBe("BusyError");
  });

  test("includes session id in message", () => {
    const error = new BusyError("my-session-42");
    expect(error.message).toContain("my-session-42");
    expect(error.message).toContain("running");
  });

  test("is instance of Error", () => {
    const error = new BusyError("test-session");
    expect(error).toBeInstanceOf(Error);
  });
});