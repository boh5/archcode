import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  getSessionsDir,
  __setSessionsDirForTest,
  assertSafeSessionId,
  getRootSessionPath,
  getRootSessionDir,
  getChildSessionPath,
  getSessionPath,
} from "./sessions-dir";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const CHILD_UUID = "660e8400-e29b-41d4-a716-446655440001";

// ---------------------------------------------------------------------------
// Existing tests (preserved)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// assertSafeSessionId
// ---------------------------------------------------------------------------

describe("assertSafeSessionId", () => {
  test("accepts valid UUID v4", () => {
    expect(() => assertSafeSessionId(VALID_UUID)).not.toThrow();
  });

  test("accepts UUID v1", () => {
    expect(() =>
      assertSafeSessionId("550e8400-e29b-11d4-a716-446655440000"),
    ).not.toThrow();
  });

  test("accepts UUID v5", () => {
    expect(() =>
      assertSafeSessionId("550e8400-e29b-51d4-a716-446655440000"),
    ).not.toThrow();
  });

  test("accepts UUID with variant nibble 'a' (10xx)", () => {
    expect(() =>
      assertSafeSessionId("550e8400-e29b-41d4-a716-446655440000"),
    ).not.toThrow();
  });

  test("accepts UUID with variant nibble 'b' (11xx)", () => {
    expect(() =>
      assertSafeSessionId("550e8400-e29b-41d4-b716-446655440000"),
    ).not.toThrow();
  });

  test("rejects empty string", () => {
    expect(() => assertSafeSessionId("")).toThrow("must be a non-empty string");
  });

  test("rejects dot", () => {
    expect(() => assertSafeSessionId(".")).toThrow("is not allowed");
  });

  test("rejects double dot", () => {
    expect(() => assertSafeSessionId("..")).toThrow("is not allowed");
  });

  test("rejects string containing forward slash", () => {
    expect(() => assertSafeSessionId("../foo")).toThrow(
      "must not contain path separators",
    );
    expect(() => assertSafeSessionId("foo/bar")).toThrow(
      "must not contain path separators",
    );
  });

  test("rejects string containing backslash", () => {
    expect(() => assertSafeSessionId("foo\\bar")).toThrow(
      "must not contain path separators",
    );
    expect(() => assertSafeSessionId("..\\bar")).toThrow(
      "must not contain path separators",
    );
  });

  test("rejects URL-encoded traversal (%2e)", () => {
    expect(() => assertSafeSessionId("%2e%2e%2ftest")).toThrow(
      "must not contain URL-encoded path characters",
    );
    expect(() => assertSafeSessionId("%2E%2Efoo")).toThrow(
      "must not contain URL-encoded path characters",
    );
  });

  test("rejects URL-encoded slash (%2f)", () => {
    expect(() => assertSafeSessionId("foo%2fbar")).toThrow(
      "must not contain URL-encoded path characters",
    );
    expect(() => assertSafeSessionId("foo%2Fbar")).toThrow(
      "must not contain URL-encoded path characters",
    );
  });

  test("rejects URL-encoded backslash (%5c)", () => {
    expect(() => assertSafeSessionId("foo%5cbar")).toThrow(
      "must not contain URL-encoded path characters",
    );
    expect(() => assertSafeSessionId("foo%5Cbar")).toThrow(
      "must not contain URL-encoded path characters",
    );
  });

  test("rejects non-UUID string", () => {
    expect(() => assertSafeSessionId("not-a-uuid")).toThrow(
      "must be a valid UUID",
    );
  });

  test("rejects UUID with wrong version nibble (version 6)", () => {
    expect(() =>
      assertSafeSessionId("550e8400-e29b-61d4-a716-446655440000"),
    ).toThrow("must be a valid UUID");
  });

  test("rejects UUID with wrong variant nibble (reserved 0xxx)", () => {
    expect(() =>
      assertSafeSessionId("550e8400-e29b-41d4-0716-446655440000"),
    ).toThrow("must be a valid UUID");
  });

  test("rejects too-long UUID", () => {
    expect(() =>
      assertSafeSessionId("550e8400-e29b-41d4-a716-4466554400000"),
    ).toThrow("must be a valid UUID");
  });

  test("rejects uppercase variant nibble outside [89ab]", () => {
    // 'C' in variant position — 1100 binary — is reserved
    expect(() =>
      assertSafeSessionId("550e8400-e29b-41d4-c716-446655440000"),
    ).toThrow("must be a valid UUID");
  });
});

// ---------------------------------------------------------------------------
// getRootSessionPath
// ---------------------------------------------------------------------------

describe("getRootSessionPath", () => {
  afterEach(() => {
    __setSessionsDirForTest(undefined);
  });

  test("returns .specra/sessions/{sessionId}.json", () => {
    const path = getRootSessionPath("/tmp/project", VALID_UUID);
    expect(path).toBe(
      join("/tmp/project", ".specra", "sessions", `${VALID_UUID}.json`),
    );
  });

  test("respects test override of sessions dir", () => {
    __setSessionsDirForTest(() => "/tmp/override-sessions");
    const path = getRootSessionPath("/any/root", VALID_UUID);
    expect(path).toBe(join("/tmp/override-sessions", `${VALID_UUID}.json`));
  });

  test("rejects invalid session ID", () => {
    expect(() => getRootSessionPath("/tmp/p", "../bad")).toThrow(
      "Invalid session ID",
    );
  });
});

// ---------------------------------------------------------------------------
// getRootSessionDir
// ---------------------------------------------------------------------------

describe("getRootSessionDir", () => {
  test("returns .specra/sessions/{rootSessionId}", () => {
    const path = getRootSessionDir("/tmp/project", VALID_UUID);
    expect(path).toBe(
      join("/tmp/project", ".specra", "sessions", VALID_UUID),
    );
  });

  test("rejects invalid root session ID", () => {
    expect(() => getRootSessionDir("/tmp/p", "../bad")).toThrow(
      "Invalid session ID",
    );
  });

  test("rejects empty root session ID", () => {
    expect(() => getRootSessionDir("/tmp/p", "")).toThrow(
      "Invalid session ID",
    );
  });
});

// ---------------------------------------------------------------------------
// getChildSessionPath
// ---------------------------------------------------------------------------

describe("getChildSessionPath", () => {
  test("returns .specra/sessions/{rootSessionId}/{sessionId}.json", () => {
    const path = getChildSessionPath("/tmp/project", VALID_UUID, CHILD_UUID);
    expect(path).toBe(
      join(
        "/tmp/project",
        ".specra",
        "sessions",
        VALID_UUID,
        `${CHILD_UUID}.json`,
      ),
    );
  });

  test("rejects invalid root session ID", () => {
    expect(() => getChildSessionPath("/tmp/p", "../bad", CHILD_UUID)).toThrow(
      "Invalid session ID",
    );
  });

  test("rejects invalid child session ID", () => {
    expect(() => getChildSessionPath("/tmp/p", VALID_UUID, "../bad")).toThrow(
      "Invalid session ID",
    );
  });
});

// ---------------------------------------------------------------------------
// getSessionPath
// ---------------------------------------------------------------------------

describe("getSessionPath", () => {
  test("returns root path when rootSessionId equals sessionId", () => {
    const path = getSessionPath("/tmp/project", VALID_UUID, VALID_UUID);
    expect(path).toBe(
      join("/tmp/project", ".specra", "sessions", `${VALID_UUID}.json`),
    );
  });

  test("returns child path when rootSessionId differs from sessionId", () => {
    const path = getSessionPath("/tmp/project", VALID_UUID, CHILD_UUID);
    expect(path).toBe(
      join(
        "/tmp/project",
        ".specra",
        "sessions",
        VALID_UUID,
        `${CHILD_UUID}.json`,
      ),
    );
  });

  test("rejects invalid rootSessionId", () => {
    expect(() => getSessionPath("/tmp/p", "../bad", VALID_UUID)).toThrow(
      "Invalid session ID",
    );
  });

  test("rejects invalid sessionId", () => {
    expect(() => getSessionPath("/tmp/p", VALID_UUID, "../bad")).toThrow(
      "Invalid session ID",
    );
  });
});
