import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionsDir, __setSessionsDirForTest } from "./sessions-dir";

describe("getSessionsDir", () => {
  test("returns ~/.specra/sessions/", () => {
    expect(getSessionsDir()).toBe(join(homedir(), ".specra", "sessions"));
  });

  test("always returns the same path (pure function)", () => {
    expect(getSessionsDir()).toBe(getSessionsDir());
  });
});

describe("__setSessionsDirForTest", () => {
  afterEach(() => {
    __setSessionsDirForTest(undefined);
  });

  test("overrides getSessionsDir return value", () => {
    const customDir = "/tmp/test-sessions";
    __setSessionsDirForTest(customDir);
    expect(getSessionsDir()).toBe(customDir);
  });

  test("resets to default when called with undefined", () => {
    __setSessionsDirForTest("/tmp/override");
    expect(getSessionsDir()).toBe("/tmp/override");

    __setSessionsDirForTest(undefined);
    expect(getSessionsDir()).toBe(join(homedir(), ".specra", "sessions"));
  });
});
