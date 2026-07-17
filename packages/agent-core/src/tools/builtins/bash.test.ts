import { afterEach, describe, expect, mock, test } from "bun:test";
import { storeManager } from "../../store/store";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, BashInputSchema, buildBashEnv, formatBashOutput, runBashCommand } from "./bash";
import { createRegistry } from "../registry";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { setProcessRunnerForTest } from "../../process/runner";

function stringToStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mockSpawnResult(stdout: string, stderr = "", exitCode = 0) {
  return {
    stdout: stringToStream(stdout),
    stderr: stringToStream(stderr),
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
  };
}

function mockCtx(
  workspaceRoot: string,
  overrides?: Partial<ToolExecutionContext>,
): ToolExecutionContext {
  return { store: {} as any,
  toolName: "bash",
  toolCallId: "call_1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["bash"]),
  cwd: workspaceRoot,
  storeManager,
    projectContext: createTestProjectContext(workspaceRoot), ...overrides,  };
}

describe("bashTool", () => {
  const testWorkspaceRoot = realpathSync.native(import.meta.dir);

  afterEach(() => {
    setProcessRunnerForTest(undefined);
  });

  test("schema rejects empty command, extra fields, and negative timeout", async () => {
    const registry = createRegistry([bashTool]);
    const ctx = mockCtx(mkdtempSync(join(tmpdir(), "bash-schema-test-")));
    try {
      const empty = await registry.execute(
        { toolName: "bash", toolCallId: "empty", input: { description: "Test empty command", command: "" } },
        ctx,
      );
      expect(empty.isError).toBe(true);

      const extra = await registry.execute(
        { toolName: "bash", toolCallId: "extra", input: { description: "Test extra field rejection", command: "pwd", extra: true } },
        ctx,
      );
      expect(extra.isError).toBe(true);

      const negativeTimeout = await registry.execute(
        { toolName: "bash", toolCallId: "timeout", input: { description: "Test negative timeout", command: "pwd", timeoutMs: -1 } },
        ctx,
      );
      expect(negativeTimeout.isError).toBe(true);
    } finally {
      rmSync(ctx.cwd, { recursive: true, force: true });
    }
  });

  test("schema rejects input without description", () => {
    const result = BashInputSchema.safeParse({ command: "pwd" });
    expect(result.success).toBe(false);
  });

  test("schema rejects empty description", () => {
    const result = BashInputSchema.safeParse({ description: "", command: "pwd" });
    expect(result.success).toBe(false);
  });

  test("schema accepts valid input with description", () => {
    const result = BashInputSchema.safeParse({ description: "Print working directory", command: "pwd" });
    expect(result.success).toBe(true);
  });

  test("schema/prepareInput rejects cwd outside workspace before spawning", async () => {
    const registry = createRegistry([bashTool]);
    const workspaceRoot = mkdtempSync(join(tmpdir(), "bash-cwd-test-"));
    try {
      const spawnMock = mock(() => mockSpawnResult(""));
      setProcessRunnerForTest(spawnMock as any);

      const result = await registry.execute(
        { toolName: "bash", toolCallId: "cwd", input: { description: "Test cwd outside workspace", command: "pwd", cwd: ".." } },
        mockCtx(workspaceRoot),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("cwd must resolve inside workspace");
      expect(spawnMock).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("env builder allowlists shell variables and excludes token/key variables", () => {
    const env = buildBashEnv({
      PATH: "/bin",
      HOME: "/home/test",
      SHELL: "/bin/bash",
      TERM: "xterm",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      API_TOKEN: "secret-token",
      OPENAI_API_KEY: "secret-key",
      OTHER: "nope",
    });

    expect(env).toEqual({
      ARCHCODE_CLI: "1",
      PATH: "/bin",
      HOME: "/home/test",
      SHELL: "/bin/bash",
      TERM: "xterm",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
    });
    expect("API_TOKEN" in env).toBe(false);
    expect("OPENAI_API_KEY" in env).toBe(false);
    expect("OTHER" in env).toBe(false);
  });

  test("safe pwd command with explicit cwd executes successfully", async () => {
    const executionCwd = mkdtempSync(join(tmpdir(), "bash-pwd-test-"));
    try {
      const captured: { argv?: readonly string[]; opts?: Record<string, unknown> } = {};
      setProcessRunnerForTest(((argv: readonly [string, ...string[]], opts: Record<string, unknown>) => {
        captured.argv = argv;
        captured.opts = opts;
        return mockSpawnResult(realpathSync.native(executionCwd) + "\n", "", 0);
      }) as any);

      const result = await runBashCommand(
        { description: "Print working directory", command: "pwd", cwd: "." },
        mockCtx(executionCwd, { projectContext: createTestProjectContext("/canonical/project") }),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain("EXIT_CODE: 0");
      expect(captured.argv).toEqual(["bash", "-c", "pwd"]);
      expect(captured.opts?.cwd).toBe(realpathSync.native(executionCwd));
      expect(captured.opts?.stdin).toBe("ignore");
      expect(captured.opts?.stdout).toBe("pipe");
      expect(captured.opts?.stderr).toBe("pipe");
    } finally {
      rmSync(executionCwd, { recursive: true, force: true });
    }
  });

  test("nonzero exit returns isError true with exit code", async () => {
    setProcessRunnerForTest(() => mockSpawnResult("", "boom\n", 7) as any);

    const result = await runBashCommand({ description: "Test nonzero exit", command: "pwd" }, mockCtx(testWorkspaceRoot));

    expect(result.isError).toBe(true);
    const nonzeroParsed = JSON.parse(result.output);
    expect(nonzeroParsed.message).toContain("STDERR:\nboom\n");
    expect(nonzeroParsed.message).toContain("EXIT_CODE: 7");
    expect(nonzeroParsed.code).toBe("TOOL_BASH_NONZERO_EXIT");
    expect(result.meta?.exitCode).toBe(7);
  });

  test("timeout kills process and returns timeout error", async () => {
    const exit = deferred<number>();
    const kill = mock(() => exit.resolve(143));
    setProcessRunnerForTest(() => ({
      stdout: stringToStream(""),
      stderr: stringToStream(""),
      exited: exit.promise,
      kill,
    }) as any);

    const result = await runBashCommand({ description: "Test timeout", command: "pwd", timeoutMs: 1 }, mockCtx(testWorkspaceRoot));

    expect(kill).toHaveBeenCalledTimes(1);
    const timeoutParsed = JSON.parse(result.output);
    expect(timeoutParsed.message).toBe("Command timed out after 1ms");
    expect(timeoutParsed.code).toBe("TOOL_BASH_TIMEOUT");
    expect(result.isError).toBe(true);
    expect(result.meta?.timedOut).toBe(true);
    expect(result.meta?.timeoutMs).toBe(1);
  });

  test("AbortSignal kills process and returns abort error", async () => {
    const exit = deferred<number>();
    const abortController = new AbortController();
    const kill = mock(() => exit.resolve(143));
    setProcessRunnerForTest(() => ({
      stdout: stringToStream(""),
      stderr: stringToStream(""),
      exited: exit.promise,
      kill,
    }) as any);

    const promise = runBashCommand(
      { description: "Test abort signal", command: "pwd" },
      mockCtx(testWorkspaceRoot, { abort: abortController.signal }),
    );
    abortController.abort();

    const result = await promise;
    expect(kill).toHaveBeenCalledTimes(1);
    const abortParsed = JSON.parse(result.output);
    expect(abortParsed.message).toBe("Command was aborted");
    expect(abortParsed.code).toBe("TOOL_BASH_ABORTED");
    expect(result.isError).toBe(true);
    expect(result.meta?.aborted).toBe(true);
  });

  test("signal exits map to bash aborted errors", async () => {
    setProcessRunnerForTest(() => ({
      stdout: stringToStream(""),
      stderr: stringToStream(""),
      exited: Promise.resolve(143),
      signalCode: "SIGTERM",
      kill: mock(() => {}),
    }) as any);

    const result = await runBashCommand({ description: "Test signal exit", command: "pwd" }, mockCtx(testWorkspaceRoot));

    expect(result.isError).toBe(true);
    const abortParsed = JSON.parse(result.output);
    expect(abortParsed.message).toBe("Command was aborted");
    expect(abortParsed.code).toBe("TOOL_BASH_ABORTED");
    expect(result.meta?.aborted).toBe(true);
    expect(result.meta?.signal).toBe("SIGTERM");
    expect(result.meta?.exitCode).toBe(143);
  });

  test("spawn failures return execution errors", async () => {
    setProcessRunnerForTest(() => {
      throw new Error("spawn failed");
    });

    const result = await runBashCommand({ description: "Test spawn failure", command: "pwd" }, mockCtx(testWorkspaceRoot));

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.message).toBe("spawn failed");
    expect(parsed.code).toBe("TOOL_EXECUTION_FAILED");
  });

  test("EAGAIN spawn failures retry in bash execution", async () => {
    const error = Object.assign(new Error("temporarily unavailable"), { code: "EAGAIN" });
    const spawn = mock(() => {
      if (spawn.mock.calls.length < 3) throw error;
      return mockSpawnResult("done\n", "", 0) as any;
    });
    setProcessRunnerForTest(spawn as any);

    const result = await runBashCommand({ description: "Test EAGAIN retry", command: "pwd" }, mockCtx(testWorkspaceRoot));

    expect(result.isError).toBe(false);
    expect(result.output).toContain("STDOUT:\ndone\n");
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  test("commands that require approval block before calling ProcessRunner", async () => {
    const registry = createRegistry([bashTool]);
    const spawnMock = mock(() => mockSpawnResult(""));
    setProcessRunnerForTest(spawnMock as any);

    const result = await registry.execute(
      { toolName: "bash", toolCallId: "denied", input: { description: "Test denied command", command: "sudo echo hi" } },
      mockCtx(testWorkspaceRoot),
    );

    expect(result.isError).toBe(false);
    expect(result.blocked?.source).toEqual({ type: "tool_permission", toolCallId: "denied", toolName: "bash" });
    expect(result.blocked?.persistentApprovalEligible).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(0);
  });

  test("worktree Bash cannot mutate canonical project state through a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "bash-protected-worktree-test-"));
    const canonicalRoot = join(root, "project");
    const worktreeRoot = join(root, "worktree");
    mkdirSync(join(canonicalRoot, ".archcode", "cache"), { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    symlinkSync(join(canonicalRoot, ".archcode"), join(worktreeRoot, "canonical-state"));

    try {
      const registry = createRegistry([bashTool]);
      const spawnMock = mock(() => mockSpawnResult(""));
      setProcessRunnerForTest(spawnMock as any);

      const result = await registry.execute(
        {
          toolName: "bash",
          toolCallId: "protected-symlink",
          input: {
            description: "Clear a cache directory",
            command: "rm -rf canonical-state/cache",
          },
        },
        mockCtx(worktreeRoot, { projectContext: createTestProjectContext(canonicalRoot) }),
      );

      expect(result.isError).toBe(true);
      expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_DENIED");
      expect(spawnMock).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("output format includes deterministic labeled sections", () => {
    expect(formatBashOutput("out", "err", 0)).toBe("STDOUT:\nout\nSTDERR:\nerr\nEXIT_CODE: 0");
  });
});
