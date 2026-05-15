import { describe, expect, test, mock, beforeEach, afterEach, beforeAll } from "bun:test";
import { z } from "zod";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import { RipgrepNotFoundError } from "../ripgrep/service";
import type { FormattedToolError, ToolErrorKind } from "../errors";
import type { RipgrepService } from "../ripgrep/service";
import type { ToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";

function mockReadableStream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });
}

function mockReadableStreamFromLines(lines: string[]): ReadableStream<Uint8Array> {
  return mockReadableStream(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
}

function createMockCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    store: {} as any,
    toolName: "glob",
    toolCallId: "test-call-id",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    agentName: "orchestrator-agent",
    startedAt: Date.now(),
    allowedTools: new Set(["glob"]),
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

describe("GlobInputSchema", () => {
  let schema: z.ZodTypeAny;

  beforeAll(async () => {
    const mod = await import("./glob");
    schema = mod.GlobInputSchema;
  });

  test("validates valid input", () => {
    const result = schema.parse({ pattern: "*.ts" }) as { pattern: string };
    expect(result.pattern).toBe("*.ts");
  });

  test("accepts optional path", () => {
    const result = schema.parse({ pattern: "*.ts", path: "src/" }) as { pattern: string; path?: string };
    expect(result.path).toBe("src/");
  });

  test("rejects unknown properties", () => {
    expect(() => schema.parse({ pattern: "*.ts", unknownField: "value" })).toThrow();
  });

  test("pattern is required", () => {
    expect(() => schema.parse({})).toThrow();
  });
});

const originalSpawn = Bun.spawn;

describe("glob tool", () => {
  let tool: ToolDescriptor<any, string | ToolExecutionResult>;
  let setRgService: (svc: RipgrepService) => void;
  let mockSpawn: ReturnType<typeof mock>;

  beforeAll(async () => {
    const mod = await import("./glob");
    tool = mod.globTool;
    setRgService = mod.setRipgrepService;
  });

  beforeEach(() => {
    setRgService(createMockRgService());

    mockSpawn = mock((..._args: any[]) => ({
      stdout: mockReadableStreamFromLines(["file1.ts", "file2.ts", "file3.ts"]),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(0),
      pid: 99999,
    }));
    (Bun as any).spawn = mockSpawn;
  });

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
  });

  test("returns list of files sorted by mtime", async () => {
    mockSpawn.mockImplementation(() => ({
      stdout: mockReadableStreamFromLines(["c.ts", "a.ts", "b.ts"]),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(0),
      pid: 99999,
    }));

    const result = await tool.execute({ pattern: "*.ts" }, createMockCtx());
    expect(result).toBe("c.ts\na.ts\nb.ts");
  });

  test("respects path parameter", async () => {
    let capturedArgs: readonly string[] = [];
    mockSpawn.mockImplementation((cmdAndArgs: readonly string[], _options?: any) => {
      capturedArgs = cmdAndArgs;
      return {
        stdout: mockReadableStreamFromLines(["src/bar.ts"]),
        stderr: mockReadableStream(""),
        exited: Promise.resolve(0),
        pid: 99999,
      };
    });

    await tool.execute({ pattern: "*.ts", path: "src/" }, createMockCtx());
    expect(capturedArgs).toContain("src/");
  });

  test("truncates to 100 results", async () => {
    const manyFiles = Array.from({ length: 150 }, (_, i) => `file${i}.ts`);
    mockSpawn.mockImplementation(() => ({
      stdout: mockReadableStreamFromLines(manyFiles),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(0),
      pid: 99999,
    }));

    const result = await tool.execute({ pattern: "*.ts" }, createMockCtx());
    expect(typeof result).toBe("string");
    if (typeof result !== "string") throw new Error("Expected string result");
    const lines = result.split("\n");
    // truncation notice adds 1 line
    expect(lines).toHaveLength(101);
    expect(lines[100]).toContain("truncated");
  });

  test("returns helpful message when no files match", async () => {
    mockSpawn.mockImplementation(() => ({
      stdout: mockReadableStream(""),
      stderr: mockReadableStream(""),
      exited: Promise.resolve(0),
      pid: 99999,
    }));

    const result = await tool.execute({ pattern: "*.xyz" }, createMockCtx());
    expect(result).toBe("No files matched pattern: *.xyz");
  });

  test("handles rg binary not found (RipgrepNotFoundError)", async () => {
    const failing = createMockRgService({
      ensure: mock(() => Promise.reject(new RipgrepNotFoundError("rg not found on this system"))),
    });
    setRgService(failing);

    const result = await tool.execute({ pattern: "*.ts" }, createMockCtx());
    expectToolError(result, {
      kind: "glob-error",
      code: "TOOL_GLOB_ERROR",
      messageIncludes: "glob failed: rg not found on this system",
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
      kind: "glob-error",
      code: "TOOL_GLOB_ERROR",
      messageIncludes: "rg exited with code 2",
    });
    expect((result as unknown as ToolExecutionResult).output).toContain("parse error: invalid pattern");
  });

  test("handles spawn error gracefully", async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("ENOENT: spawn rg ENOENT");
    });

    const result = await tool.execute({ pattern: "*.ts" }, createMockCtx());
    expectToolError(result, {
      kind: "glob-error",
      code: "TOOL_GLOB_ERROR",
      messageIncludes: "ENOENT",
    });
  });

  test("workspace permission asks for path outside workspace", async () => {
    const perm = tool.permissions![0];

    const decision = await perm({ pattern: "*.ts", path: "../outside" }, createMockCtx());
    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("outside");
    expect(decision.approval?.scope).toMatchObject({ kind: "file-path", operation: "read", pathMode: "exact" });
  });

  test("workspace permission allows path within workspace", async () => {
    const perm = tool.permissions![0];

    const decision = await perm({ pattern: "*.ts", path: "src/" }, createMockCtx());
    expect(decision.outcome).toBe("allow");
  });

  test("workspace permission allows when no path provided", async () => {
    const perm = tool.permissions![0];

    const decision = await perm({ pattern: "*.ts" }, createMockCtx());
    expect(decision.outcome).toBe("allow");
  });
});
