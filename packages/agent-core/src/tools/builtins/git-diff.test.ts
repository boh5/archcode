import { describe, expect, test, mock, afterEach } from "bun:test";
import { gitDiffTool, buildArgs } from "./git-diff";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createTestProjectContext } from "../test-project-context";

// ─── Helpers ───

function stringToStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) {
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  });
}

function mockSpawnResult(stdout: string, stderr = "", exitCode = 0) {
  return {
    stdout: stringToStream(stdout),
    stderr: stringToStream(stderr),
    exited: Promise.resolve(exitCode),
    get success() {
      return exitCode === 0;
    },
  };
}

function mockCtx(): ToolExecutionContext {
  return {
    store: {} as any,
    toolName: "git_diff",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["git_diff"]),
    workspaceRoot: "/tmp/workspace",
    projectContext: createTestProjectContext("/tmp/workspace"),
  };
}

// ─── buildArgs ───

describe("buildArgs", () => {
  test("default unstaged args", () => {
    expect(buildArgs(false)).toEqual([
      "diff",
      "--no-color",
      "--unified=3",
      "--no-ext-diff",
      "--no-renames",
    ]);
  });

  test("staged args include --staged", () => {
    expect(buildArgs(true)).toEqual([
      "diff",
      "--staged",
      "--no-color",
      "--unified=3",
      "--no-ext-diff",
      "--no-renames",
    ]);
  });
});

// ─── gitDiffTool ───

describe("gitDiffTool", () => {
  const originalSpawn = Bun.spawn;

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  test("returns diff output for unstaged changes (default)", async () => {
    const diffOutput = [
      "diff --git a/foo.ts b/foo.ts",
      "index abc..def 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+line2 modified",
      " line3",
    ].join("\n");

    // @ts-expect-error — Bun.spawn is mutable in test environment
    Bun.spawn = mock((_cmd: string[], _opts?: Record<string, unknown>) =>
      mockSpawnResult(diffOutput),
    );

    const result = await gitDiffTool.execute({ staged: false }, mockCtx());
    expect(result).toBe(diffOutput);
  });

  test("returns diff output for staged changes (staged=true)", async () => {
    const diffOutput = [
      "diff --git a/bar.ts b/bar.ts",
      "index 123..456 100644",
      "--- a/bar.ts",
      "+++ b/bar.ts",
      "@@ -1 +1 @@",
      "-old content",
      "+new content",
    ].join("\n");

    // @ts-expect-error — Bun.spawn is mutable in test environment
    Bun.spawn = mock((_cmd: string[], _opts?: Record<string, unknown>) =>
      mockSpawnResult(diffOutput),
    );

    const result = await gitDiffTool.execute({ staged: true }, mockCtx());
    expect(result).toBe(diffOutput);
  });

  test("returns structured error on git command failure", async () => {
    // @ts-expect-error — Bun.spawn is mutable in test environment
    Bun.spawn = mock((_cmd: string[], _opts?: Record<string, unknown>) =>
      mockSpawnResult("", "fatal: not a git repository", 128),
    );

    const result = (await gitDiffTool.execute(
      { staged: false },
      mockCtx(),
    )) as ToolExecutionResult;
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("execution");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(result.output).toContain("Git diff failed");
  });

  test("returns helpful message for empty diff (no changes)", async () => {
    // @ts-expect-error — Bun.spawn is mutable in test environment
    Bun.spawn = mock((_cmd: string[], _opts?: Record<string, unknown>) =>
      mockSpawnResult(""),
    );

    const result = await gitDiffTool.execute({ staged: false }, mockCtx());
    expect(result).toBe("No changes detected");
  });

  test("passes abort signal to spawn", async () => {
    const abortController = new AbortController();
    const ctx = mockCtx();
    ctx.abort = abortController.signal;

    let capturedOpts: Record<string, unknown> | null = null;

    // @ts-expect-error — Bun.spawn is mutable in test environment
    Bun.spawn = mock((_cmd: string[], opts?: Record<string, unknown>) => {
      capturedOpts = opts ?? null;
      return mockSpawnResult("");
    });

    await gitDiffTool.execute({ staged: false }, ctx);
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.signal).toBe(abortController.signal);
  });

  test("uses workspaceRoot as cwd", async () => {
    let capturedOpts: Record<string, unknown> | null = null;

    // @ts-expect-error — Bun.spawn is mutable in test environment
    Bun.spawn = mock((_cmd: string[], opts?: Record<string, unknown>) => {
      capturedOpts = opts ?? null;
      return mockSpawnResult("");
    });

    await gitDiffTool.execute({ staged: false }, mockCtx());
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.cwd).toBe("/tmp/workspace");
  });

  test("sets GIT_OPTIONAL_LOCKS=0 in environment", async () => {
    let capturedOpts: Record<string, unknown> | null = null;

    // @ts-expect-error — Bun.spawn is mutable in test environment
    Bun.spawn = mock((_cmd: string[], opts?: Record<string, unknown>) => {
      capturedOpts = opts ?? null;
      return mockSpawnResult("");
    });

    await gitDiffTool.execute({ staged: false }, mockCtx());
    expect(capturedOpts).not.toBeNull();
    expect((capturedOpts!.env as Record<string, string>).GIT_OPTIONAL_LOCKS).toBe("0");
  });
});
