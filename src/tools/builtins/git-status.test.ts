import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseGitStatusOutput, gitStatusTool } from "./git-status";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createTestProjectContext } from "../test-project-context";

function exec(cmd: string, args: string[], cwd: string): void {
  const result = Bun.spawnSync([cmd, ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `"${cmd} ${args.join(" ")}" failed: ${result.stderr.toString().trim()}`,
    );
  }
}

function initRepo(dir: string): void {
  exec("git", ["init"], dir);
  exec("git", ["config", "user.email", "test@test.com"], dir);
  exec("git", ["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "tracked.txt"), "initial content");
  exec("git", ["add", "."], dir);
  exec("git", ["commit", "-m", "initial"], dir);
}

function mockCtx(
  tmpDir: string,
  overrides?: Partial<ToolExecutionContext>,
): ToolExecutionContext {
  return {
    store: {} as any,
    toolName: "git_status",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["git_status"]),
    workspaceRoot: tmpDir,
    projectContext: createTestProjectContext(tmpDir),
    ...overrides,
  };
}

describe("parseGitStatusOutput", () => {
  test("parses NUL-delimited porcelain output", () => {
    const raw = "M  src/foo.ts\0A  bar.ts\0?? untracked.ts\0";
    expect(parseGitStatusOutput(raw)).toBe(
      "M  src/foo.ts\nA  bar.ts\n?? untracked.ts",
    );
  });

  test("handles empty output (clean working tree)", () => {
    expect(parseGitStatusOutput("")).toBe("");
  });

  test("handles single entry without trailing NUL", () => {
    expect(parseGitStatusOutput("M  file.ts")).toBe("M  file.ts");
  });

  test("handles only NUL characters", () => {
    expect(parseGitStatusOutput("\0\0\0")).toBe("");
  });

  test("preserves all status prefix variants", () => {
    const raw =
      " M staged.ts\0MM both.ts\0A  added.ts\0 D deleted.ts\0?? untracked.ts\0" +
      "R  renamed.ts\0C  copied.ts\0U unmerged.ts";
    expect(parseGitStatusOutput(raw)).toBe(
      " M staged.ts\nMM both.ts\nA  added.ts\n D deleted.ts\n?? untracked.ts\n" +
      "R  renamed.ts\nC  copied.ts\nU unmerged.ts",
    );
  });
});

describe("gitStatusTool", () => {
  let tmpDir = "";

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-status-test-"));
    initRepo(tmpDir);
  });

  afterEach(() => {
    exec("git", ["checkout", "."], tmpDir);
    exec("git", ["clean", "-fd"], tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty output for clean working tree", async () => {
    const ctx = mockCtx(tmpDir);
    const result = await gitStatusTool.execute({}, ctx);
    expect(result).toBe("");
  });

  test("returns formatted output for changed files", async () => {
    writeFileSync(join(tmpDir, "tracked.txt"), "modified content");
    writeFileSync(join(tmpDir, "untracked.txt"), "new file");

    const ctx = mockCtx(tmpDir);
    const result = await gitStatusTool.execute({}, ctx);

    expect(result).toContain(" M tracked.txt");
    expect(result).toContain("?? untracked.txt");
    expect((result as string).split("\n").length).toBe(2);
  });

  test("handles git command failure (non-git directory)", async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "git-status-non-repo-"));
    try {
      const ctx = mockCtx(nonGitDir);
      const result = (await gitStatusTool.execute({}, ctx)) as ToolExecutionResult;
      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("execution");
      expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  test("passes abort signal to spawn", async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = mockCtx(tmpDir, { abort: ac.signal });
    const result = (await gitStatusTool.execute({}, ctx)) as ToolExecutionResult;
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("execution");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
  });
});
