import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolExecutionContext } from "../types";
import { createMemoryIndexGuard } from "./memory-index-guard";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "memory-index-guard");
const WORKSPACE = join(TMP_DIR, "workspace");
const INDEX_PATH = join(WORKSPACE, ".specra", "memory", "index.md");
const SYMLINK_DIR = join(TMP_DIR, "symlinks");

const guard = createMemoryIndexGuard();

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

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Create workspace directory structure with index.md
  mkdirSync(join(WORKSPACE, ".specra", "memory", "knowledge"), {
    recursive: true,
  });
  writeFileSync(INDEX_PATH, "# Memory Index\n\n- [Test](test.md) — A test entry\n");

  // Create a directory for symlink tests
  mkdirSync(SYMLINK_DIR, { recursive: true });
  symlinkSync(INDEX_PATH, join(SYMLINK_DIR, "link-to-index.md"));
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Denied: writes targeting index.md
// ---------------------------------------------------------------------------

describe("createMemoryIndexGuard", () => {
  test("denies direct write to .specra/memory/index.md (relative path)", async () => {
    const decision = await guard({ path: ".specra/memory/index.md" }, makeCtx());

    expect(decision).toEqual({
      outcome: "deny",
      reason:
        "Memory index is system-managed and cannot be edited directly. " +
        "Use memory_write to update topic files, which automatically rebuilds the index.",
      errorKind: "permission-denied",
      errorCode: "MEMORY_INDEX_WRITE_DENIED",
    });
  });

  test("denies write via absolute path to index.md", async () => {
    const decision = await guard({ path: INDEX_PATH }, makeCtx());

    expect(decision.outcome).toBe("deny");
    expect(decision.errorKind).toBe("permission-denied");
    expect(decision.errorCode).toBe("MEMORY_INDEX_WRITE_DENIED");
  });

  test("denies path traversal to index.md", async () => {
    // Resolving `.specra/memory/knowledge/../index.md` yields the index file.
    const decision = await guard(
      { path: ".specra/memory/knowledge/../index.md" },
      makeCtx(),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.errorCode).toBe("MEMORY_INDEX_WRITE_DENIED");
  });

  test("denies write to index.md via symlink target", async () => {
    const symlinkPath = join(SYMLINK_DIR, "link-to-index.md");
    const decision = await guard({ path: symlinkPath }, makeCtx());

    expect(decision.outcome).toBe("deny");
    expect(decision.errorCode).toBe("MEMORY_INDEX_WRITE_DENIED");
  });

  // -----------------------------------------------------------------------
  // Denied: edit operations on index.md (same guard via file_edit)
  // -----------------------------------------------------------------------

  test("denies edit operation on index.md (file_edit path)", async () => {
    const decision = await guard(
      { path: ".specra/memory/index.md", edits: [{ oldString: "foo", newString: "bar" }] },
      makeCtx({ toolName: "file_edit" }),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.errorCode).toBe("MEMORY_INDEX_WRITE_DENIED");
  });

  // -----------------------------------------------------------------------
  // Allowed: non-index paths
  // -----------------------------------------------------------------------

  test("allows write to memory topic file in knowledge/", async () => {
    const decision = await guard(
      { path: ".specra/memory/knowledge/debugging.md", content: "tips" },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows write to a regular source file", async () => {
    const decision = await guard(
      { path: "src/main.ts", content: "console.log('hi')" },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows write to a path outside .specra/memory", async () => {
    const decision = await guard(
      { path: "README.md", content: "# readme" },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows write to knowledge/index.md (separate topic, not system index)", async () => {
    const decision = await guard(
      { path: ".specra/memory/knowledge/index.md", content: "# A topic called index" },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test("allows when path is missing from input", async () => {
    const decision = await guard({ content: "no path" }, makeCtx());

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows when path is undefined", async () => {
    const decision = await guard({ path: undefined, content: "stuff" }, makeCtx());

    expect(decision).toEqual({ outcome: "allow" });
  });
});
