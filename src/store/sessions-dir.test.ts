import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionsDir } from "./sessions-dir";

describe("getSessionsDir", () => {
  test("returns ~/.specra/sessions/", () => {
    expect(getSessionsDir()).toBe(join(homedir(), ".specra", "sessions"));
  });

  test("always returns the same path (pure function)", () => {
    expect(getSessionsDir()).toBe(getSessionsDir());
  });
});
