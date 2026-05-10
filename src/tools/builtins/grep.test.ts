import { describe, expect, test, mock, beforeEach, afterEach, beforeAll } from "bun:test";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import { RipgrepNotFoundError } from "../ripgrep/service";
import type { FormattedToolError, ToolErrorKind } from "../errors";
import type { RipgrepService } from "../ripgrep/service";
import type { ToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";

// ─── Helpers ───

function mockReadableStream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });
}

function createMockCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    store: {} as any,
    toolName: "grep",
    toolCallId: "test-call-id",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    agentName: "orchestrator-agent",
    startedAt: Date.now(),
    allowedTools: new Set(["grep"]),
    workspaceRoot: "/workspace",
    ...overrides,
  };
}

function createMockRgService(overrides?: Partial<RipgrepService>): RipgrepService {
  return {
    ensure: mock(() => Promise.resolve("/usr/local/bin/rg")),
    ...overrides,
  };
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

// ─── Fixtures ───

const sampleNdjson = [
  '{"type":"match","data":{"path":{"text":"file1.ts"},"lines":{"text":"hello world"},"line_number":42}}',
  '{"type":"match","data":{"path":{"text":"file2.ts"},"lines":{"text":"hello foo"},"line_number":10}}',
].join("\n") + "\n";

const originalSpawn = Bun.spawn;

// ─── Tests ───

describe("grep tool", () => {
  let tool: ToolDescriptor<any, string | ToolExecutionResult>;
  let setRgService: (svc: RipgrepService) => void;
  let mockSpawn: ReturnType<typeof mock>;

  beforeAll(async () => {
    const mod = await import("./grep");
    tool = mod.grepTool;
    setRgService = mod.setRipgrepService;
  });

  beforeEach(() => {
    setRgService(createMockRgService());
    mockSpawn = mock((..._args: any[]) => ({
      stdout: mockReadableStream(sampleNdjson),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(0),
      pid: 99999,
    }));
    (Bun as any).spawn = mockSpawn;
  });

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
  });

  test("returns formatted results for successful search", async () => {
    const result = await tool.execute({ pattern: "hello" }, createMockCtx());
    expect(result).toBe("file1.ts:42:hello world\nfile2.ts:10:hello foo");
  });

  test("returns no matches message when result is empty", async () => {
    mockSpawn.mockImplementation(() => ({
      stdout: mockReadableStream(""),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(0),
      pid: 99999,
    }));

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
    mockSpawn.mockImplementation(() => ({
      stdout: mockReadableStream(""),
      stderr: mockReadableStream("parse error: invalid pattern"),
      exited: Promise.resolve(2),
      pid: 99999,
    }));

    const result = await tool.execute({ pattern: "[" }, createMockCtx());
    expectToolError(result, {
      kind: "grep-error",
      code: "TOOL_GREP_ERROR",
      messageIncludes: "rg exited with code 2",
    });
    expect((result as unknown as ToolExecutionResult).output).toContain("parse error: invalid pattern");
  });

  test("handles spawn throw gracefully", async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("ENOENT: spawn rg ENOENT");
    });

    const result = await tool.execute({ pattern: "foo" }, createMockCtx());
    expectToolError(result, {
      kind: "grep-error",
      code: "TOOL_GREP_ERROR",
      messageIncludes: "ENOENT",
    });
  });

  test("formats output in files_with_matches mode", async () => {
    mockSpawn.mockImplementation(() => ({
      stdout: mockReadableStream("file1.ts\nfile2.ts\n"),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(0),
      pid: 99999,
    }));

    const result = await tool.execute(
      { pattern: "hello", output_mode: "files_with_matches" },
      createMockCtx(),
    );
    expect(result).toBe("file1.ts\nfile2.ts");
  });

  test("formats output in count mode", async () => {
    mockSpawn.mockImplementation(() => ({
      stdout: mockReadableStream("file1.ts:2\nfile2.ts:1\n"),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(0),
      pid: 99999,
    }));

    const result = await tool.execute(
      { pattern: "hello", output_mode: "count" },
      createMockCtx(),
    );
    expect(result).toBe("file1.ts:2\nfile2.ts:1");
  });

  test("files_with_matches mode returns no matches message on empty result", async () => {
    mockSpawn.mockImplementation(() => ({
      stdout: mockReadableStream(""),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(1),
      pid: 99999,
    }));

    const result = await tool.execute(
      { pattern: "nonexistent", output_mode: "files_with_matches" },
      createMockCtx(),
    );
    expect(result).toBe("No matches found for pattern: nonexistent");
  });

  test("count mode returns no matches message on empty result", async () => {
    mockSpawn.mockImplementation(() => ({
      stdout: mockReadableStream(""),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(1),
      pid: 99999,
    }));

    const result = await tool.execute(
      { pattern: "nonexistent", output_mode: "count" },
      createMockCtx(),
    );
    expect(result).toBe("No matches found for pattern: nonexistent");
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

  test("workspace guard allows when no path provided", async () => {
    const guard = tool.guards![0];
    const decision = await guard({ pattern: "foo" }, createMockCtx());
    expect(decision.outcome).toBe("allow");
  });

  test("workspace guard allows path within workspace", async () => {
    const guard = tool.guards![0];
    const decision = await guard({ pattern: "foo", path: "src/" }, createMockCtx());
    expect(decision.outcome).toBe("allow");
  });

  test("workspace guard denies path outside workspace", async () => {
    const guard = tool.guards![0];
    const decision = await guard({ pattern: "foo", path: "../outside" }, createMockCtx());
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("outside");
  });

  test("respects path parameter", async () => {
    let capturedArgs: readonly string[] = [];
    mockSpawn.mockImplementation((cmdAndArgs: readonly string[], _options?: any) => {
      capturedArgs = cmdAndArgs;
      return {
        stdout: mockReadableStream(sampleNdjson),
        stderr: mockReadableStream(""),
        exited: Promise.resolve(0),
        pid: 99999,
      };
    });

    await tool.execute({ pattern: "hello", path: "src/" }, createMockCtx());
    expect(capturedArgs).toContain("src/");
  });

  test("respects include (glob) parameter", async () => {
    let capturedArgs: readonly string[] = [];
    mockSpawn.mockImplementation((cmdAndArgs: readonly string[], _options?: any) => {
      capturedArgs = cmdAndArgs;
      return {
        stdout: mockReadableStream(sampleNdjson),
        stderr: mockReadableStream(""),
        exited: Promise.resolve(0),
        pid: 99999,
      };
    });

    await tool.execute({ pattern: "hello", include: "*.ts" }, createMockCtx());
    const globIndex = capturedArgs.indexOf("--glob");
    expect(globIndex).not.toBe(-1);
    expect(capturedArgs[globIndex + 1]).toBe("*.ts");
  });
});
