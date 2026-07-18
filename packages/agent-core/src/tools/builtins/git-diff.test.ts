import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiffTool, buildArgs } from "./git-diff";
import { expectSettledResult } from "../test-results";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { createTestToolRegistryFixture } from "../test-registry";
import { setProcessRunnerForTest } from "../../process/runner";
import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";

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

const workspaceRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "archcode-git-diff-")));
const registryFixture = createTestToolRegistryFixture({ descriptors: [gitDiffTool] });

function mockCtx(): ToolExecutionContext {
  return {
    store: createMockStore(),
    storeManager,
    toolName: "git_diff",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["git_diff"]),
    cwd: workspaceRoot,
    projectContext: createTestProjectContext(workspaceRoot),
  };
}

async function execute(input: { staged?: boolean }, ctx = mockCtx()) {
  return expectSettledResult(await registryFixture.registry.execute(
    { toolName: "git_diff", toolCallId: ctx.toolCallId, input },
    ctx,
  ));
}

afterAll(async () => {
  await registryFixture.dispose();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

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

    const result = await execute({ staged: false });
    expect(result.output.preview).toBe(diffOutput);
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

    const result = await execute({ staged: true });
    expect(result.output.preview).toBe(diffOutput);
  });

  test("returns structured error on git command failure", async () => {
    setProcessRunnerForTest(mock((_cmd, _opts) =>
      mockSpawnResult("", "fatal: not a git repository", 128),
    ));

    const result = await execute({ staged: false });
    expect(result.isError).toBe(true);
    expect(result.details?.error).toMatchObject({ kind: "execution" });
    expect(result.output.preview).toContain("Git diff failed");
  });

  test("returns an empty complete preview for an empty diff", async () => {
    setProcessRunnerForTest(mock((_cmd, _opts) =>
      mockSpawnResult(""),
    ));

    const result = await execute({ staged: false });
    expect(result.output.preview).toBe("");
    expect(result.output.completeness).toBe("complete");
  });

  test("uses ProcessRunner abort behavior", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const ctx = mockCtx();
    ctx.abort = abortController.signal;

    setProcessRunnerForTest(mock((_cmd, opts) => {
      expect(opts.cwd).toBe(workspaceRoot);
      return mockSpawnResult("");
    }));

    const result = await execute({ staged: false }, ctx);
    expect(result.isError).toBe(true);
    expect(result.details?.error).toMatchObject({ kind: "execution", code: "TOOL_PROCESS_ABORTED" });
    expect(result.output.preview).toContain("Git diff was aborted");
  });

  test("uses execution cwd instead of the canonical project root", async () => {
    let capturedOpts: { cwd?: string } | null = null;

    setProcessRunnerForTest(mock((_cmd, opts) => {
      capturedOpts = opts ?? null;
      return mockSpawnResult("");
    }));

    await execute({ staged: false });
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.cwd).toBe(workspaceRoot);
  });

  test("sets GIT_OPTIONAL_LOCKS=0 in environment", async () => {
    let capturedOpts: { env?: Record<string, string> } | null = null;

    setProcessRunnerForTest(mock((_cmd, opts) => {
      capturedOpts = opts ?? null;
      return mockSpawnResult("");
    }));

    await execute({ staged: false });
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.env?.GIT_OPTIONAL_LOCKS).toBe("0");
  });
});
