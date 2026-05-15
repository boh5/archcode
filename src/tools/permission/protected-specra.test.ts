import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolExecutionContext } from "../types";
import { createProtectedSpecraPermission } from "./protected-specra";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "protected-specra-permission");
const WORKSPACE = join(TMP_DIR, "workspace");
const SYMLINK_DIR = join(TMP_DIR, "symlinks");

const permission = createProtectedSpecraPermission();

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    store: {} as ToolExecutionContext["store"],
    toolName: "file_write",
    toolCallId: "call-1",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set<string>(),
    workspaceRoot: WORKSPACE,
    ...overrides,
  };
}

beforeAll(() => {
  // Create workspace with various .specra sub-paths
  mkdirSync(join(WORKSPACE, ".specra", "memory", "knowledge"), {
    recursive: true,
  });
  mkdirSync(join(WORKSPACE, ".specra", "sessions"), {
    recursive: true,
  });
  writeFileSync(
    join(WORKSPACE, ".specra", "memory", "index.md"),
    "# Memory Index\n\n- [Test](test.md) — A test entry\n",
  );

  // Create a symlink directory for symlink traversal tests
  mkdirSync(SYMLINK_DIR, { recursive: true });
  symlinkSync(
    join(WORKSPACE, ".specra", "memory", "index.md"),
    join(SYMLINK_DIR, "link-to-index.md"),
  );
  // Symlink to .specra dir itself
  symlinkSync(
    join(WORKSPACE, ".specra"),
    join(SYMLINK_DIR, "link-to-specra"),
  );
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("createProtectedSpecraPermission", () => {
  // ─── Deny: .specra/ paths ───

  test("denies file_write to .specra/permissions.json", async () => {
    const decision = await permission(
      { path: ".specra/permissions.json", content: "{}" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "SPECRA_PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies file_edit to .specra/memory/index.md", async () => {
    const decision = await permission(
      { path: ".specra/memory/index.md", edits: [{ oldString: "foo", newString: "bar" }] },
      makeCtx({ toolName: "file_edit" }),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "SPECRA_PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies file_write to .specra/memory/knowledge/topic.md", async () => {
    const decision = await permission(
      { path: ".specra/memory/knowledge/topic.md", content: "# topic" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "SPECRA_PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies file_write to .specra/sessions/abc.json", async () => {
    const decision = await permission(
      { path: ".specra/sessions/abc.json", content: "{}" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "SPECRA_PROTECTED_PATH_WRITE_DENIED",
    });
  });

  // ─── Deny: traversal & symlink attacks ───

  test("denies path traversal into .specra/", async () => {
    const decision = await permission(
      { path: "src/../.specra/permissions.json" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "SPECRA_PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies write via absolute path to .specra/", async () => {
    const decision = await permission(
      { path: join(WORKSPACE, ".specra", "memory", "index.md") },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "SPECRA_PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies write to .specra/ via symlink target", async () => {
    const symlinkPath = join(SYMLINK_DIR, "link-to-index.md");
    const decision = await permission({ path: symlinkPath }, makeCtx());

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "SPECRA_PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies write to path under symlinked .specra/ dir", async () => {
    const deviousPath = join(SYMLINK_DIR, "link-to-specra", "permissions.json");
    const decision = await permission({ path: deviousPath }, makeCtx());

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "SPECRA_PROTECTED_PATH_WRITE_DENIED",
    });
  });

  // ─── Allow: non-.specra paths ───

  test("allows file_write to normal workspace file", async () => {
    const decision = await permission(
      { path: "src/main.ts", content: "console.log('hi')" },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows file_edit to normal workspace file", async () => {
    const decision = await permission(
      { path: "src/main.ts", edits: [{ oldString: "foo", newString: "bar" }] },
      makeCtx({ toolName: "file_edit" }),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows write to path outside workspace", async () => {
    const decision = await permission(
      { path: "/tmp/random-file.txt", content: "data" },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  // ─── Edge cases ───

  test("allows when path is missing from input", async () => {
    const decision = await permission({ content: "no path" }, makeCtx());

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows when path is undefined", async () => {
    const decision = await permission({ path: undefined }, makeCtx());

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows non-.specra dotfile paths", async () => {
    const decision = await permission(
      { path: ".env", content: "SECRET=foo" },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });
});
