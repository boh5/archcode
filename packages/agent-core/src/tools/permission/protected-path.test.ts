import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { storeManager } from "../../store/store";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolExecutionContext } from "../types";
import { createProtectedPathPermission } from "./protected-path";
import { createTestProjectContext } from "../test-project-context";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "protected-path-permission");
const WORKSPACE = join(TMP_DIR, "workspace");
const SYMLINK_DIR = join(TMP_DIR, "symlinks");

const permission = createProtectedPathPermission();

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return { store: {} as ToolExecutionContext["store"],
  toolName: "file_write",
  toolCallId: "call-1",
  input: {},
  step: 0,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set<string>(),
  workspaceRoot: WORKSPACE,
  storeManager,
    projectContext: createTestProjectContext(WORKSPACE), ...overrides,  };
}

beforeAll(() => {
  // Create workspace with various .archcode sub-paths
  mkdirSync(join(WORKSPACE, ".archcode", "memory", "knowledge"), {
    recursive: true,
  });
  mkdirSync(join(WORKSPACE, ".archcode", "sessions"), {
    recursive: true,
  });
  writeFileSync(
    join(WORKSPACE, ".archcode", "memory", "index.md"),
    "# Memory Index\n\n- [Test](test.md) — A test entry\n",
  );

  // Create a symlink directory for symlink traversal tests
  mkdirSync(SYMLINK_DIR, { recursive: true });
  symlinkSync(
    join(WORKSPACE, ".archcode", "memory", "index.md"),
    join(SYMLINK_DIR, "link-to-index.md"),
  );
  // Symlink to .archcode dir itself
  symlinkSync(
    join(WORKSPACE, ".archcode"),
    join(SYMLINK_DIR, "link-to-archcode"),
  );
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("createProtectedPathPermission", () => {
  // ─── Deny: .archcode/ paths ───

  test("denies file_write to .archcode/permissions.json", async () => {
    const decision = await permission(
      { path: ".archcode/permissions.json", content: "{}" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies file_edit to .archcode/memory/index.md", async () => {
    const decision = await permission(
      { path: ".archcode/memory/index.md", edits: [{ oldString: "foo", newString: "bar" }] },
      makeCtx({ toolName: "file_edit" }),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies file_write to .archcode/memory/knowledge/topic.md", async () => {
    const decision = await permission(
      { path: ".archcode/memory/knowledge/topic.md", content: "# topic" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies file_write to .archcode/sessions/abc.json", async () => {
    const decision = await permission(
      { path: ".archcode/sessions/abc.json", content: "{}" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies command text references to the .archcode directory itself", async () => {
    for (const command of [
      "python3 -c \"import shutil; shutil.rmtree('.archcode')\"",
      "python3 -c \"open('.archcode','w')\"",
      `python3 -c "import shutil; shutil.rmtree('${join(WORKSPACE, ".archcode")}')"`,
    ]) {
      const decision = await permission({ command }, makeCtx({ toolName: "bash" }));

      expect(decision, command).toMatchObject({
        outcome: "deny",
        errorKind: "permission-denied",
        errorCode: "PROTECTED_PATH_WRITE_DENIED",
      });
    }
  });

  // ─── Deny: traversal & symlink attacks ───

  test("denies path traversal into .archcode/", async () => {
    const decision = await permission(
      { path: "src/../.archcode/permissions.json" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies write via absolute path to .archcode/", async () => {
    const decision = await permission(
      { path: join(WORKSPACE, ".archcode", "memory", "index.md") },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies write to .archcode/ via symlink target", async () => {
    const symlinkPath = join(SYMLINK_DIR, "link-to-index.md");
    const decision = await permission({ path: symlinkPath }, makeCtx());

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies write to path under symlinked .archcode/ dir", async () => {
    const deviousPath = join(SYMLINK_DIR, "link-to-archcode", "permissions.json");
    const decision = await permission({ path: deviousPath }, makeCtx());

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  // ─── Allow: non-.archcode paths ───

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

  test("allows non-.archcode dotfile paths", async () => {
    const decision = await permission(
      { path: ".env", content: "SECRET=foo" },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });
});
