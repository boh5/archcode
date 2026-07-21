import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { storeManager } from "../../store/store";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolExecutionContext } from "../types";
import { createProtectedPathPermission, isProtectedCanonicalWritePath } from "./protected-path";
import { createTestProjectContext } from "../test-project-context";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "protected-path-permission", crypto.randomUUID());
const WORKSPACE = join(TMP_DIR, "workspace");
const WORKTREE = join(TMP_DIR, "worktree");
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
  cwd: WORKSPACE,
  storeManager,
    projectContext: createTestProjectContext(WORKSPACE), ...overrides,  };
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
  // Create workspace with various .archcode sub-paths
  mkdirSync(join(WORKSPACE, ".archcode", "memory", "knowledge"), {
    recursive: true,
  });
  mkdirSync(join(WORKSPACE, ".archcode", "sessions"), {
    recursive: true,
  });
  mkdirSync(join(WORKTREE, ".archcode"), { recursive: true });
  mkdirSync(join(WORKSPACE, ".git", "worktrees", "managed"), { recursive: true });
  writeFileSync(join(WORKSPACE, ".git", "config"), "[core]\n\tbare = false\n");
  writeFileSync(join(WORKSPACE, ".git", "worktrees", "managed", "gitdir"), `${join(WORKTREE, ".git")}\n`);
  writeFileSync(join(WORKTREE, ".git"), `gitdir: ${join(WORKSPACE, ".git", "worktrees", "managed")}\n`);
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
  symlinkSync(
    join(WORKSPACE, ".archcode"),
    join(WORKTREE, "canonical-project-state"),
  );
  symlinkSync(join(WORKSPACE, ".git"), join(SYMLINK_DIR, "link-to-git"));
  symlinkSync(join(WORKSPACE, ".git"), join(WORKTREE, "canonical-git-metadata"));
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

  test("allows only a root non-Discussion Lead to write direct Markdown Plan files", async () => {
    mkdirSync(join(WORKSPACE, ".archcode", "plans"), { recursive: true });
    const leadStore = storeManager.create(crypto.randomUUID(), WORKSPACE, {
      agentName: "lead",
    });
    const leadContext = makeCtx({ store: leadStore, agentName: "lead" });

    expect(await permission({ path: ".archcode/plans/release plan.md" }, leadContext)).toEqual({ outcome: "allow" });
    expect(await permission({ path: join(WORKSPACE, ".archcode", "plans", "release.md") }, leadContext)).toEqual({ outcome: "allow" });

    for (const path of [
      ".archcode/plans/nested/release.md",
      ".archcode/plans/release.txt",
      ".archcode/plans/../release.md",
      ".archcode/memory/release.md",
    ]) {
      expect(await permission({ path }, leadContext), path).toMatchObject({
        outcome: "deny",
        errorCode: "PROTECTED_PATH_WRITE_DENIED",
      });
    }

    storeManager.delete(leadStore.getState().sessionId, WORKSPACE);
  });

  test("denies Plan writes from child, non-Lead, Discussion, Bash, and AST contexts", async () => {
    mkdirSync(join(WORKSPACE, ".archcode", "plans"), { recursive: true });
    const rootId = crypto.randomUUID();
    const rootLead = storeManager.create(rootId, WORKSPACE, { agentName: "lead" });
    const child = storeManager.create(crypto.randomUUID(), WORKSPACE, {
      agentName: "build",
      rootSessionId: rootId,
      parentSessionId: rootId,
      delegationRequest: {
        agent_type: "build",
        profile: "deep",
        title: "Build",
        objective: "Build",
        skills: [],
        background: true,
      },
    });
    const discussion = storeManager.create(crypto.randomUUID(), WORKSPACE, { agentName: "lead" });
    const path = ".archcode/plans/release.md";

    for (const ctx of [
      makeCtx({ store: child, agentName: "build" }),
      makeCtx({ store: discussion, agentName: "lead", projectContext: {
        ...createTestProjectContext(WORKSPACE),
        todos: {
          state: { findByDiscussionSessionId: async () => ({ id: "todo" }) },
        },
      } as unknown as ToolExecutionContext["projectContext"] }),
      makeCtx({ store: rootLead, agentName: "lead", toolName: "bash" }),
      makeCtx({ store: rootLead, agentName: "lead", toolName: "ast_grep_replace" }),
    ]) {
      expect(await permission({ path }, ctx)).toMatchObject({
        outcome: "deny",
        errorCode: "PROTECTED_PATH_WRITE_DENIED",
      });
    }

    storeManager.delete(child.getState().sessionId, WORKSPACE);
    storeManager.delete(rootLead.getState().sessionId, WORKSPACE);
    storeManager.delete(discussion.getState().sessionId, WORKSPACE);
  });

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

  test("protects the lexical .archcode entry without protecting an ordinary symlink entry", () => {
    expect(isProtectedCanonicalWritePath(join(WORKSPACE, ".archcode"), makeCtx())).toBe(true);
    expect(isProtectedCanonicalWritePath(join(WORKSPACE, ".archcode", "child"), makeCtx())).toBe(true);
    expect(isProtectedCanonicalWritePath(join(WORKSPACE, "ordinary-control-link"), makeCtx())).toBe(false);
  });

  test("denies both worktree and canonical project state from a worktree Session", async () => {
    for (const { toolName, input } of [
      {
        toolName: "file_write",
        input: { path: ".archcode/local.json", content: "{}" },
      },
      {
        toolName: "file_edit",
        input: {
          path: join(WORKSPACE, ".archcode", "memory", "index.md"),
          edits: [{ oldString: "old", newString: "new" }],
        },
      },
      {
        toolName: "ast_grep_replace",
        input: {
          paths: [join(WORKSPACE, ".archcode", "memory")],
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

  test("denies canonical project state reached through a worktree symlink", async () => {
    const decision = await permission(
      { path: join(WORKTREE, "canonical-project-state", "permissions.json") },
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
