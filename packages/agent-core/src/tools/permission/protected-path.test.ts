import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { storeManager } from "../../store/store";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolExecutionContext } from "../types";
import { createProtectedPathPermission, isProtectedCanonicalMutationPath } from "./protected-path";
import { createTestProjectContext } from "../test-project-context";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "protected-path-permission", crypto.randomUUID());
const WORKSPACE = join(TMP_DIR, "workspace");
const WORKTREE = join(TMP_DIR, "worktree");
const SYMLINK_DIR = join(TMP_DIR, "symlinks");
const SESSION_ID = "11111111-1111-1111-1111-111111111111";

const permission = createProtectedPathPermission();

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
    cwd: WORKSPACE,
    storeManager,
    projectContext: createTestProjectContext(WORKSPACE),
    ...overrides,
  };
}

function makeWorktreeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return makeCtx({
    cwd: WORKTREE,
    projectContext: createTestProjectContext(WORKSPACE),
    ...overrides,
  });
}

beforeAll(() => {
  mkdirSync(join(WORKSPACE, ".archcode", "runtime", "memory", "knowledge"), {
    recursive: true,
  });
  mkdirSync(join(WORKSPACE, ".archcode", "runtime", "sessions", SESSION_ID), {
    recursive: true,
  });
  mkdirSync(join(WORKSPACE, ".archcode", "plans"), { recursive: true });
  mkdirSync(join(WORKSPACE, ".archcode", "skills", "x"), { recursive: true });
  mkdirSync(join(WORKTREE, ".archcode", "runtime"), { recursive: true });
  mkdirSync(join(WORKSPACE, ".git", "worktrees", "managed"), { recursive: true });
  writeFileSync(join(WORKSPACE, ".git", "config"), "[core]\n\tbare = false\n");
  writeFileSync(join(WORKSPACE, ".git", "worktrees", "managed", "gitdir"), `${join(WORKTREE, ".git")}\n`);
  writeFileSync(join(WORKTREE, ".git"), `gitdir: ${join(WORKSPACE, ".git", "worktrees", "managed")}\n`);
  writeFileSync(
    join(WORKSPACE, ".archcode", "runtime", "memory", "index.md"),
    "# Memory Index\n\n- [Test](test.md) — A test entry\n",
  );
  writeFileSync(
    join(WORKSPACE, ".archcode", "runtime", "permissions.json"),
    "{}\n",
  );
  writeFileSync(
    join(WORKSPACE, ".archcode", "runtime", "sessions", SESSION_ID, "session.json"),
    "{}\n",
  );
  writeFileSync(join(WORKSPACE, ".archcode", "plans", "foo.md"), "# plan\n");
  writeFileSync(join(WORKSPACE, ".archcode", "skills", "x", "SKILL.md"), "# skill\n");

  mkdirSync(SYMLINK_DIR, { recursive: true });
  symlinkSync(
    join(WORKSPACE, ".archcode", "runtime", "memory", "index.md"),
    join(SYMLINK_DIR, "link-to-index.md"),
  );
  symlinkSync(
    join(WORKSPACE, ".archcode", "runtime"),
    join(SYMLINK_DIR, "link-to-archcode-runtime"),
  );
  symlinkSync(
    join(WORKSPACE, ".archcode", "runtime"),
    join(WORKTREE, "canonical-project-runtime"),
  );
  symlinkSync(join(WORKSPACE, ".git"), join(SYMLINK_DIR, "link-to-git"));
  symlinkSync(join(WORKSPACE, ".git"), join(WORKTREE, "canonical-git-metadata"));
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("createProtectedPathPermission", () => {
  // ─── Deny: .archcode/runtime/** ───

  test("denies file_write to .archcode/runtime/permissions.json", async () => {
    const decision = await permission(
      { path: ".archcode/runtime/permissions.json", content: "{}" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies file_edit to .archcode/runtime/memory/index.md", async () => {
    const decision = await permission(
      { path: ".archcode/runtime/memory/index.md", edits: [{ oldString: "foo", newString: "bar" }] },
      makeCtx({ toolName: "file_edit" }),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies file_write to .archcode/runtime/memory/knowledge/topic.md", async () => {
    const decision = await permission(
      { path: ".archcode/runtime/memory/knowledge/topic.md", content: "# topic" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies file_write to .archcode/runtime/sessions/{id}/session.json", async () => {
    const decision = await permission(
      {
        path: `.archcode/runtime/sessions/${SESSION_ID}/session.json`,
        content: "{}",
      },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorKind: "permission-denied",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies mutation of the .archcode container that owns runtime", async () => {
    const decision = await permission(
      { path: ".archcode", content: "blocked" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  // ─── Allow: non-runtime .archcode artifacts (plans / skills) ───

  test("allows file_write to .archcode/plans/foo.md for any agent context", async () => {
    for (const ctx of [
      makeCtx(),
      makeCtx({ toolName: "file_edit", agentName: "build" }),
      makeCtx({ toolName: "bash", agentName: "lead" }),
      makeCtx({ toolName: "ast_grep_replace", agentName: "build" }),
    ]) {
      const decision = await permission(
        { path: ".archcode/plans/foo.md", content: "# plan\n" },
        ctx,
      );
      expect(decision, ctx.toolName).toEqual({ outcome: "allow" });
    }
  });

  test("allows file_write to .archcode/skills/x/SKILL.md", async () => {
    const decision = await permission(
      { path: ".archcode/skills/x/SKILL.md", content: "# skill\n" },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows nested plan paths via protected-path (not a protect deny)", async () => {
    const decision = await permission(
      { path: ".archcode/plans/nested/release.md", content: "# plan\n" },
      makeCtx({ agentName: "build" }),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows an AST selection root that contains runtime and rechecks actual matches", async () => {
    const decision = await permission(
      { paths: ["."], pattern: "old", rewrite: "new", dryRun: false },
      makeCtx({ toolName: "ast_grep_replace" }),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  // ─── Deny: Git metadata ───

  test("denies direct writes to canonical and linked-worktree Git metadata", async () => {
    for (const { input, ctx } of [
      { input: { path: ".git/config", content: "tampered" }, ctx: makeCtx() },
      { input: { path: join(WORKSPACE, ".git", "worktrees", "managed", "gitdir"), content: "tampered" }, ctx: makeWorktreeCtx() },
      { input: { path: ".git", content: "tampered" }, ctx: makeWorktreeCtx() },
      { input: { path: "vendor/nested/.git/config", content: "tampered" }, ctx: makeCtx() },
      { input: { path: join(SYMLINK_DIR, "link-to-git", "config"), content: "tampered" }, ctx: makeCtx() },
    ]) {
      const decision = await permission(input, ctx);
      expect(decision).toMatchObject({
        outcome: "deny",
        errorKind: "permission-denied",
        errorCode: "PROTECTED_PATH_WRITE_DENIED",
      });
    }
  });

  test("does not confuse ordinary Git CLI and nearby dot paths with direct metadata writes", async () => {
    for (const input of [
      { path: ".gitignore", content: "dist/\n" },
      { path: ".github/workflows/ci.yml", content: "name: ci\n" },
    ]) {
      expect(await permission(input, makeCtx())).toEqual({ outcome: "allow" });
    }
  });

  // ─── Deny: traversal & symlink attacks into runtime ───

  test("denies path traversal into .archcode/runtime/", async () => {
    const decision = await permission(
      { path: "src/../.archcode/runtime/permissions.json" },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies write via absolute path to .archcode/runtime/", async () => {
    const decision = await permission(
      { path: join(WORKSPACE, ".archcode", "runtime", "memory", "index.md") },
      makeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies write to .archcode/runtime/ via symlink target", async () => {
    const symlinkPath = join(SYMLINK_DIR, "link-to-index.md");
    const decision = await permission({ path: symlinkPath }, makeCtx());

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("denies write to path under symlinked .archcode/runtime/ dir", async () => {
    const deviousPath = join(SYMLINK_DIR, "link-to-archcode-runtime", "permissions.json");
    const decision = await permission({ path: deviousPath }, makeCtx());

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  // ─── isProtectedCanonicalMutationPath: protected-tree intersection matrix ───

  test("protects runtime and its ancestors while leaving plans and skills writable", () => {
    const ctx = makeCtx();

    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode", "runtime"), ctx)).toBe(true);
    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode", "runtime", "state"), ctx)).toBe(true);
    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode", "runtime", "memory", "index.md"), ctx)).toBe(true);
    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode"), ctx)).toBe(true);
    expect(isProtectedCanonicalMutationPath(WORKSPACE, ctx)).toBe(true);

    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode", "plans"), ctx)).toBe(false);
    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode", "plans", "p.md"), ctx)).toBe(false);
    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode", "skills", "x", "SKILL.md"), ctx)).toBe(false);

    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, "ordinary-control-link"), ctx)).toBe(false);
  });

  test("bash mutation path denies runtime state without denying plans", () => {
    const ctx = makeCtx({ toolName: "bash" });

    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode"), ctx)).toBe(true);
    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode", "runtime", "state"), ctx)).toBe(true);
    expect(isProtectedCanonicalMutationPath(join(WORKSPACE, ".archcode", "plans", "p.md"), ctx)).toBe(false);
  });

  test("denies both worktree-local and canonical workspace runtime from a worktree Session", async () => {
    for (const { toolName, input } of [
      {
        toolName: "file_write",
        input: { path: ".archcode/runtime/local.json", content: "{}" },
      },
      {
        toolName: "file_edit",
        input: {
          path: join(WORKSPACE, ".archcode", "runtime", "memory", "index.md"),
          edits: [{ oldString: "old", newString: "new" }],
        },
      },
      {
        toolName: "ast_grep_replace",
        input: {
          paths: [join(WORKSPACE, ".archcode", "runtime", "memory")],
          pattern: "old",
          rewrite: "new",
          dryRun: false,
        },
      },
    ] as const) {
      const decision = await permission(input, makeWorktreeCtx({ toolName }));

      expect(decision, toolName).toMatchObject({
        outcome: "deny",
        errorKind: "permission-denied",
        errorCode: "PROTECTED_PATH_WRITE_DENIED",
      });
    }
  });

  test("denies canonical runtime reached through a worktree symlink", async () => {
    const decision = await permission(
      { path: join(WORKTREE, "canonical-project-runtime", "permissions.json") },
      makeWorktreeCtx(),
    );

    expect(decision).toMatchObject({
      outcome: "deny",
      errorCode: "PROTECTED_PATH_WRITE_DENIED",
    });
  });

  test("does not protect ordinary canonical project files from the project-state guard", async () => {
    const decision = await permission(
      { path: join(WORKSPACE, "src", "main.ts"), content: "export {};" },
      makeWorktreeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  // ─── Allow: non-runtime paths ───

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
