import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { storeManager } from "../../store/store";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, BashInputSchema, buildBashEnv, formatBashOutput, runBashCommand } from "./bash";
import type { RawToolResult, RegistryExecutionOutcome, ToolExecutionContext } from "../types";
import { createTestToolRegistryFixture } from "../test-registry";
import { createTestProjectContext } from "../test-project-context";
import { setProcessRunnerForTest } from "../../process/runner";

const registryFixture = createTestToolRegistryFixture({ descriptors: [bashTool] });
const ownedSessionStores: Array<{ sessionId: string; workspaceRoot: string }> = [];
let directCapturedText = "";

function rawText(result: RawToolResult): string {
  if (result.draft.kind !== "text") throw new Error("Expected text draft");
  return result.draft.text;
}

function settled(outcome: RegistryExecutionOutcome) {
  if (outcome.kind !== "settled") throw new Error("Expected settled Registry outcome");
  return outcome.result;
}

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
  directCapturedText = "";
  const defaultCapture = {
    async write(chunk: string | Uint8Array) {
      directCapturedText += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return "accepted" as const;
    },
  };
  const sessionWorkspaceRoot = mkdtempSync(join(tmpdir(), "bash-session-store-"));
  const sessionId = crypto.randomUUID();
  ownedSessionStores.push({ sessionId, workspaceRoot: sessionWorkspaceRoot });
  return {
    store: storeManager.create(sessionId, sessionWorkspaceRoot, { agentName: "engineer" }),
    toolName: "bash",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["bash"]),
    cwd: workspaceRoot,
    storeManager,
    projectContext: createTestProjectContext(workspaceRoot),
    outputCapture: defaultCapture as any,
    ...overrides,
  };
}

describe("bashTool", () => {
  const testWorkspaceRoot = realpathSync.native(import.meta.dir);

  afterEach(async () => {
    setProcessRunnerForTest(undefined);
    await Promise.all(ownedSessionStores.map(({ sessionId, workspaceRoot }) => storeManager.flushSession(sessionId, workspaceRoot)));
    for (const { sessionId, workspaceRoot } of ownedSessionStores) {
      storeManager.delete(sessionId, workspaceRoot);
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
    ownedSessionStores.length = 0;
  });

  afterAll(async () => {
    await registryFixture.dispose();
  });

  test("schema rejects empty command, extra fields, and negative timeout", async () => {
    const registry = registryFixture.registry;
    const ctx = mockCtx(mkdtempSync(join(tmpdir(), "bash-schema-test-")));
    try {
      const empty = await registry.execute(
        { toolName: "bash", toolCallId: "empty", input: { description: "Test empty command", command: "" } },
        ctx,
      );
      expect(settled(empty).isError).toBe(true);

      const extra = await registry.execute(
        { toolName: "bash", toolCallId: "extra", input: { description: "Test extra field rejection", command: "pwd", extra: true } },
        ctx,
      );
      expect(settled(extra).isError).toBe(true);

      const negativeTimeout = await registry.execute(
        { toolName: "bash", toolCallId: "timeout", input: { description: "Test negative timeout", command: "pwd", timeoutMs: -1 } },
        ctx,
      );
      expect(settled(negativeTimeout).isError).toBe(true);
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
    const registry = registryFixture.registry;
    const workspaceRoot = mkdtempSync(join(tmpdir(), "bash-cwd-test-"));
    try {
      const spawnMock = mock(() => mockSpawnResult(""));
      setProcessRunnerForTest(spawnMock as any);

      const result = await registry.execute(
        { toolName: "bash", toolCallId: "cwd", input: { description: "Test cwd outside workspace", command: "pwd", cwd: ".." } },
        mockCtx(workspaceRoot),
      );

      expect(settled(result).isError).toBe(true);
      expect(settled(result).output.preview).toContain("cwd must resolve inside workspace");
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
      expect(directCapturedText).toContain("EXIT_CODE: 0");
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
    expect(directCapturedText).toContain("STDERR:\nboom\n");
    expect(directCapturedText).toContain("EXIT_CODE: 7");
    expect(result.details?.error?.code).toBe("TOOL_BASH_NONZERO_EXIT");
    expect(result.details?.process?.exitCode).toBe(7);
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
    expect(result.details?.error?.code).toBe("TOOL_BASH_TIMEOUT");
    expect(result.isError).toBe(true);
    expect(result.details?.process?.timedOut).toBe(true);
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
    expect(result.details?.error?.code).toBe("TOOL_BASH_ABORTED");
    expect(result.isError).toBe(true);
    expect(result.details?.process?.aborted).toBe(true);
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
    expect(result.details?.error?.code).toBe("TOOL_BASH_ABORTED");
    expect(result.details?.process?.aborted).toBe(true);
    expect(result.details?.process?.signal).toBe("SIGTERM");
    expect(result.details?.process?.exitCode).toBe(143);
  });

  test("spawn failures return execution errors", async () => {
    setProcessRunnerForTest(() => {
      throw new Error("spawn failed");
    });

    const result = await runBashCommand({ description: "Test spawn failure", command: "pwd" }, mockCtx(testWorkspaceRoot));

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(rawText(result));
    expect(parsed.message).toBe("Process failed to start");
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
    expect(directCapturedText).toContain("STDOUT:\ndone\n");
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  test("labels every stdout/stderr transition in the canonical stream", async () => {
    const chunks = (values: string[]) => new ReadableStream<Uint8Array>({
      pull(controller) {
        const value = values.shift();
        if (value === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(value));
      },
    }, { highWaterMark: 0 });
    setProcessRunnerForTest(() => ({
      stdout: chunks(["out-1", "out-2"]),
      stderr: chunks(["err-1", "err-2"]),
      exited: Promise.resolve(0),
      exitCode: 0,
      signalCode: null,
      kill: mock(() => {}),
    }) as any);
    let canonical = "";
    const outputCapture = {
      async write(chunk: string | Uint8Array) {
        canonical += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return "accepted" as const;
      },
    };

    const result = await runBashCommand(
      { description: "Test interleaved output", command: "fake" },
      mockCtx(testWorkspaceRoot, { outputCapture: outputCapture as any }),
    );

    expect(result.isError).toBe(false);
    expect(canonical).toBe(
      "STDOUT:\nout-1\nSTDERR:\nerr-1\nSTDOUT:\nout-2\nSTDERR:\nerr-2\nEXIT_CODE: 0\n",
    );
  });

  test("includes an explicit empty stream segment in the canonical stream", async () => {
    setProcessRunnerForTest(() => mockSpawnResult("stdout-only", "", 0) as any);

    const result = await runBashCommand(
      { description: "Test stdout-only output", command: "fake" },
      mockCtx(testWorkspaceRoot),
    );

    expect(result.isError).toBe(false);
    expect(directCapturedText).toBe("STDOUT:\nstdout-only\nSTDERR:\n\nEXIT_CODE: 0\n");
  });

  test("commands that require approval block before calling ProcessRunner", async () => {
    const registry = registryFixture.registry;
    const spawnMock = mock(() => mockSpawnResult(""));
    setProcessRunnerForTest(spawnMock as any);

    const result = await registry.execute(
      { toolName: "bash", toolCallId: "denied", input: { description: "Test denied command", command: "sudo echo hi" } },
      mockCtx(testWorkspaceRoot),
    );

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("Expected blocked Registry outcome");
    expect(result.request.source).toEqual({ type: "tool_permission", toolCallId: "denied", toolName: "bash" });
    expect("persistentApprovalEligible" in result.request && result.request.persistentApprovalEligible).toBe(true);
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
      const registry = registryFixture.registry;
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

      expect(settled(result).isError).toBe(true);
      expect(settled(result).details?.error?.code).toBe("TOOL_PERMISSION_DENIED");
      expect(spawnMock).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("output format includes deterministic labeled sections", () => {
    expect(formatBashOutput("out", "err", 0)).toBe("STDOUT:\nout\nSTDERR:\nerr\nEXIT_CODE: 0");
  });
});
