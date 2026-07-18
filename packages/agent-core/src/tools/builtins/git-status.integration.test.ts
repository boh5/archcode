import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { storeManager } from "../../store/store";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitStatusTool } from "./git-status";
import { expectSettledResult } from "../test-results";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { createTestToolRegistryFixture } from "../test-registry";
import { setProcessRunnerForTest } from "../../process/runner";
import { createMockStore } from "../../store/test-helpers";

const registryFixture = createTestToolRegistryFixture({ descriptors: [gitStatusTool] });

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
  return { store: createMockStore({ cwd: tmpDir }),
  toolName: "git_status",
  toolCallId: "call_1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["git_status"]),
  cwd: tmpDir,
  storeManager,
    projectContext: createTestProjectContext(tmpDir), ...overrides,  };
}

async function execute(ctx: ToolExecutionContext) {
  return expectSettledResult(await registryFixture.registry.execute(
    { toolName: "git_status", toolCallId: ctx.toolCallId, input: {} },
    ctx,
  ));
}

describe("gitStatusTool", () => {
  let tmpDir = "";

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-status-test-"));
    initRepo(tmpDir);
  });

  afterEach(() => {
    setProcessRunnerForTest(undefined);
    exec("git", ["checkout", "."], tmpDir);
    exec("git", ["clean", "-fd"], tmpDir);
  });

  afterAll(async () => {
    await registryFixture.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty output for clean working tree", async () => {
    const ctx = mockCtx(tmpDir);
    const result = await execute(ctx);
    expect(result.output.preview).toBe("");
  });

  test("returns formatted output for changed files", async () => {
    writeFileSync(join(tmpDir, "tracked.txt"), "modified content");
    writeFileSync(join(tmpDir, "untracked.txt"), "new file");

    const ctx = mockCtx(tmpDir);
    const result = await execute(ctx);

    const output = result.output.preview;
    expect(output).toContain(" M tracked.txt");
    expect(output).toContain("?? untracked.txt");
    expect(output.trimEnd().split("\n")).toHaveLength(2);
  });

  test("handles git command failure (non-git directory)", async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "git-status-non-repo-"));
    try {
      const ctx = mockCtx(nonGitDir);
      const result = await execute(ctx);
      expect(result.isError).toBe(true);
      expect(result.details?.error).toMatchObject({ kind: "execution" });
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  test("uses ProcessRunner abort behavior", async () => {
    const ac = new AbortController();
    ac.abort();
    setProcessRunnerForTest((_argv, opts) => {
      expect(opts.cwd).toBe(tmpDir);
      expect(opts.env?.GIT_OPTIONAL_LOCKS).toBe("0");
      return {
        stdout: new ReadableStream({ start(controller) { controller.close(); } }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        kill() {},
      };
    });
    const ctx = mockCtx(tmpDir, { abort: ac.signal });
    const result = await execute(ctx);
    expect(result.isError).toBe(true);
    expect(result.details?.error).toMatchObject({ kind: "execution", code: "TOOL_PROCESS_ABORTED" });
    expect(result.output.preview).toContain("git status was aborted");
  });
});
