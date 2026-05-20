import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getSessionsDir, __setSessionsDirForTest } from "./sessions-dir";

describe("getSessionsDir", () => {
  test("returns workspaceRoot/.specra/sessions/", () => {
    expect(getSessionsDir("/tmp/project-a")).toBe(
      join("/tmp/project-a", ".specra", "sessions"),
    );
  });

  test("returns different path for different workspace root", () => {
    const dirA = getSessionsDir("/tmp/project-a");
    const dirB = getSessionsDir("/tmp/project-b");
    expect(dirA).not.toBe(dirB);
    expect(dirA).toBe(join("/tmp/project-a", ".specra", "sessions"));
    expect(dirB).toBe(join("/tmp/project-b", ".specra", "sessions"));
  });
});

describe("__setSessionsDirForTest", () => {
  afterEach(() => {
    __setSessionsDirForTest(undefined);
  });

  test("overrides getSessionsDir return value regardless of workspaceRoot", () => {
    __setSessionsDirForTest(() => "/tmp/test-sessions");
    expect(getSessionsDir("/any/root")).toBe("/tmp/test-sessions");
  });

  test("resets to default when called with undefined", () => {
    __setSessionsDirForTest(() => "/tmp/override");
    expect(getSessionsDir("/tmp/project")).toBe("/tmp/override");

    __setSessionsDirForTest(undefined);
    expect(getSessionsDir("/tmp/project")).toBe(
      join("/tmp/project", ".specra", "sessions"),
    );
  });
});
