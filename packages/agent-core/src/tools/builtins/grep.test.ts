import { describe, expect, test, mock, beforeEach, afterEach, beforeAll } from "bun:test";
import { storeManager } from "../../store/store";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import { RipgrepNotFoundError } from "../ripgrep/service";
import type { FormattedToolError, ToolErrorKind } from "../errors";
import type { RipgrepService } from "../ripgrep/service";
import type { ToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { setProcessRunnerForTest } from "../../process/runner";

function mockReadableStream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });
}

function mockSpawnResult(stdout: string, stderr = "", exitCode = 0) {
  return {
    stdout: mockReadableStream(stdout),
    stderr: mockReadableStream(stderr),
    exited: Promise.resolve(exitCode),
    exitCode,
    kill: mock(() => undefined),
  };
}

function createMockCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return { store: {} as any,
  toolName: "grep",
  toolCallId: "test-call-id",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  agentName: "orchestrator-agent",
  startedAt: Date.now(),
  allowedTools: new Set(["grep"]),
  cwd: "/workspace",
  storeManager,
    projectContext: createTestProjectContext("/workspace"), ...overrides,  };
}

function createMockRgService(overrides?: Partial<RipgrepService>): RipgrepService {
  return { ensure: mock(() => Promise.resolve("/usr/local/bin/rg")), ...overrides,  };
}

function expectToolError(
  result: unknown,
  expected: { kind: ToolErrorKind; code: string; messageIncludes?: string },
) {
  const r = result as ToolExecutionResult;
  expect(r.isError).toBe(true);
  expect(inferToolErrorKindFromResult(r)).toBe(expected.kind);
  const toolError = r.meta?.[TOOL_ERROR_META_KEY] as FormattedToolError | undefined;
  expect(toolError?.kind).toBe(expected.kind);
  expect(toolError?.code).toBe(expected.code);
  if (expected.messageIncludes) {
    expect(r.output).toContain(expected.messageIncludes);
  }
}

const sampleNdjson = [
  '{"type":"match","data":{"path":{"text":"file1.ts"},"lines":{"text":"hello world"},"line_number":42}}',
  '{"type":"match","data":{"path":{"text":"file2.ts"},"lines":{"text":"hello foo"},"line_number":10}}',
].join("\n") + "\n";

// ─── Tests ───

describe("grep tool", () => {
  let tool: ToolDescriptor<any, string | ToolExecutionResult>;
  let setRgService: (svc: RipgrepService) => void;

  beforeAll(async () => {
    const mod = await import("./grep");
    tool = mod.grepTool;
    setRgService = mod.setRipgrepService;
  });

  beforeEach(() => {
    setRgService(createMockRgService());
    setProcessRunnerForTest(
      mock(() => mockSpawnResult(sampleNdjson)),
    );
  });

  afterEach(() => {
    setProcessRunnerForTest(undefined);
  });

  test("returns formatted results for successful search", async () => {
    const result = await tool.execute({ pattern: "hello" }, createMockCtx());
    expect(result).toBe("file1.ts:42:hello world\nfile2.ts:10:hello foo");
  });

  test("runs from execution cwd instead of the canonical project root", async () => {
    const executionCwd = "/worktrees/session-grep";
    let spawnedCwd: string | undefined;
    setProcessRunnerForTest(mock((_argv: unknown, options: { cwd?: string }) => {
      spawnedCwd = options.cwd;
      return mockSpawnResult(sampleNdjson);
    }) as NonNullable<Parameters<typeof setProcessRunnerForTest>[0]>);

    await tool.execute({ pattern: "hello" }, createMockCtx({
      cwd: executionCwd,
      projectContext: createTestProjectContext("/canonical/project"),
    }));

    expect(spawnedCwd).toBe(executionCwd);
  });

  test("returns no matches message when result is empty", async () => {
    setProcessRunnerForTest(
      mock(() => mockSpawnResult("")),
    );

    const result = await tool.execute({ pattern: "nonexistent" }, createMockCtx());
    expect(result).toBe("No matches found for pattern: nonexistent");
  });

  test("handles rg binary not found (RipgrepNotFoundError)", async () => {
    const failing = createMockRgService({
      ensure: mock(() => Promise.reject(new RipgrepNotFoundError("rg not found"))),
    });
    setRgService(failing);

    const result = await tool.execute({ pattern: "foo" }, createMockCtx());
    expectToolError(result, {
      kind: "grep-error",
      code: "TOOL_GREP_ERROR",
      messageIncludes: "grep failed: rg not found",
    });
  });

  test("handles spawn error exit code >= 2", async () => {
    setProcessRunnerForTest(
      mock(() => mockSpawnResult("", "parse error: invalid pattern", 2)),
    );

    const result = await tool.execute({ pattern: "[" }, createMockCtx());
    expectToolError(result, {
      kind: "grep-error",
      code: "TOOL_GREP_ERROR",
      messageIncludes: "rg exited with code 2",
    });
    expect((result as unknown as ToolExecutionResult).output).toContain("parse error: invalid pattern");
  });

  test("handles spawn throw gracefully", async () => {
    setProcessRunnerForTest(
      mock(() => {
        throw new Error("ENOENT: spawn rg ENOENT");
      }),
    );

    const result = await tool.execute({ pattern: "foo" }, createMockCtx());
    expectToolError(result, {
      kind: "grep-error",
      code: "TOOL_GREP_ERROR",
      messageIncludes: "ENOENT",
    });
  });

  test("formats output in files_with_matches mode", async () => {
    setProcessRunnerForTest(
      mock(() => mockSpawnResult("file1.ts\nfile2.ts\n")),
    );

    const result = await tool.execute(
      { pattern: "hello", output_mode: "files_with_matches" },
      createMockCtx(),
    );
    expect(result).toBe("file1.ts\nfile2.ts");
  });

  test("formats output in count mode", async () => {
    setProcessRunnerForTest(
      mock(() => mockSpawnResult("file1.ts:2\nfile2.ts:1\n")),
    );

    const result = await tool.execute(
      { pattern: "hello", output_mode: "count" },
      createMockCtx(),
    );
    expect(result).toBe("file1.ts:2\nfile2.ts:1");
  });

  test("files_with_matches mode returns no matches message on empty result", async () => {
    setProcessRunnerForTest(
      mock(() => mockSpawnResult("", "", 1)),
    );

    const result = await tool.execute(
      { pattern: "nonexistent", output_mode: "files_with_matches" },
      createMockCtx(),
    );
    expect(result).toBe("No matches found for pattern: nonexistent");
  });

  test("count mode returns no matches message on empty result", async () => {
    setProcessRunnerForTest(
      mock(() => mockSpawnResult("", "", 1)),
    );

    const result = await tool.execute(
      { pattern: "nonexistent", output_mode: "count" },
      createMockCtx(),
    );
    expect(result).toBe("No matches found for pattern: nonexistent");
  });

  test("treats exit code 1 with non-empty stdout as error (broken binary)", async () => {
    setProcessRunnerForTest(
      mock(() => mockSpawnResult("rg shim file was executed...", "", 1)),
    );

    const result = await tool.execute({ pattern: "test" }, createMockCtx());
    expectToolError(result, {
      kind: "grep-error",
      code: "TOOL_GREP_ERROR",
      messageIncludes: "rg exited with code 1",
    });
  });

  test("treats exit code 1 with non-empty stderr as error", async () => {
    setProcessRunnerForTest(
      mock(() => mockSpawnResult("", "error: inaccessible files", 1)),
    );

    const result = await tool.execute({ pattern: "test" }, createMockCtx());
    expectToolError(result, {
      kind: "grep-error",
      code: "TOOL_GREP_ERROR",
      messageIncludes: "error: inaccessible files",
    });
  });

  test("rejects unknown input fields", () => {
    const parse = tool.inputSchema.safeParse({
      pattern: "foo",
      unknown_field: "bar",
    });
    expect(parse.success).toBe(false);
  });

  test("accepts valid input with all fields", () => {
    const parse = tool.inputSchema.safeParse({
      pattern: "foo",
      path: "src/",
      include: "*.ts",
      output_mode: "content",
      context: 3,
    });
    expect(parse.success).toBe(true);
  });

  test("accepts minimal input (pattern only)", () => {
    const parse = tool.inputSchema.safeParse({ pattern: "foo" });
    expect(parse.success).toBe(true);
  });

  test("workspace permission allows when no path provided", async () => {
    const perm = tool.permissions![0];
    const decision = await perm({ pattern: "foo" }, createMockCtx());
    expect(decision.outcome).toBe("allow");
  });

  test("workspace permission allows path within workspace", async () => {
    const perm = tool.permissions![0];
    const decision = await perm({ pattern: "foo", path: "src/" }, createMockCtx());
    expect(decision.outcome).toBe("allow");
  });

  test("workspace permission asks for path outside workspace", async () => {
    const perm = tool.permissions![0];
    const decision = await perm({ pattern: "foo", path: "../outside" }, createMockCtx());
    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("outside");
    expect(decision.approval?.scope).toMatchObject({ kind: "file-path", operation: "read", pathMode: "exact" });
  });

  test("respects path parameter", async () => {
    let capturedArgs: readonly string[] = [];
    setProcessRunnerForTest(
      mock((cmdAndArgs: readonly [string, ...string[]]) => {
        capturedArgs = cmdAndArgs;
        return mockSpawnResult(sampleNdjson);
      }),
    );

    await tool.execute({ pattern: "hello", path: "src/" }, createMockCtx());
    expect(capturedArgs).toContain("src/");
  });

  test("respects include (glob) parameter", async () => {
    let capturedArgs: readonly string[] = [];
    setProcessRunnerForTest(
      mock((cmdAndArgs: readonly [string, ...string[]]) => {
        capturedArgs = cmdAndArgs;
        return mockSpawnResult(sampleNdjson);
      }),
    );

    await tool.execute({ pattern: "hello", include: "*.ts" }, createMockCtx());
    const globIndex = capturedArgs.indexOf("--glob");
    expect(globIndex).not.toBe(-1);
    expect(capturedArgs[globIndex + 1]).toBe("*.ts");
  });
});
