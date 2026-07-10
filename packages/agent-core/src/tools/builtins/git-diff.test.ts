import { describe, expect, test, mock, afterEach } from "bun:test";
import { gitDiffTool, buildArgs } from "./git-diff";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { setProcessRunnerForTest } from "../../process/runner";
import { storeManager } from "../../store/store";

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
    kill() {},
  };
}

function mockCtx(): ToolExecutionContext {
  return {
    store: {} as any,
    storeManager,
    toolName: "git_diff",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["git_diff"]),
    cwd: "/tmp/workspace",
    projectContext: createTestProjectContext("/canonical/project"),
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
  afterEach(() => {
    setProcessRunnerForTest(undefined);
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

    setProcessRunnerForTest(mock((_cmd, _opts) =>
      mockSpawnResult(diffOutput),
    ));

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

    setProcessRunnerForTest(mock((_cmd, _opts) =>
      mockSpawnResult(diffOutput),
    ));

    const result = await gitDiffTool.execute({ staged: true }, mockCtx());
    expect(result).toBe(diffOutput);
  });

  test("returns structured error on git command failure", async () => {
    setProcessRunnerForTest(mock((_cmd, _opts) =>
      mockSpawnResult("", "fatal: not a git repository", 128),
    ));

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
    setProcessRunnerForTest(mock((_cmd, _opts) =>
      mockSpawnResult(""),
    ));

    const result = await gitDiffTool.execute({ staged: false }, mockCtx());
    expect(result).toBe("No changes detected");
  });

  test("uses ProcessRunner abort behavior", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const ctx = mockCtx();
    ctx.abort = abortController.signal;

    setProcessRunnerForTest(mock((_cmd, opts) => {
      expect(opts.cwd).toBe("/tmp/workspace");
      return mockSpawnResult("");
    }));

    const result = (await gitDiffTool.execute({ staged: false }, ctx)) as ToolExecutionResult;
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("execution");
    expect(result.output).toContain("Git diff was aborted");
  });

  test("uses execution cwd instead of the canonical project root", async () => {
    let capturedOpts: { cwd?: string } | null = null;

    setProcessRunnerForTest(mock((_cmd, opts) => {
      capturedOpts = opts ?? null;
      return mockSpawnResult("");
    }));

    await gitDiffTool.execute({ staged: false }, mockCtx());
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.cwd).toBe("/tmp/workspace");
  });

  test("sets GIT_OPTIONAL_LOCKS=0 in environment", async () => {
    let capturedOpts: { env?: Record<string, string> } | null = null;

    setProcessRunnerForTest(mock((_cmd, opts) => {
      capturedOpts = opts ?? null;
      return mockSpawnResult("");
    }));

    await gitDiffTool.execute({ staged: false }, mockCtx());
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.env?.GIT_OPTIONAL_LOCKS).toBe("0");
  });
});
