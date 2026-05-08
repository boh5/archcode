import { describe, expect, test, mock, spyOn, beforeEach, afterEach, beforeAll } from "bun:test";
import { z } from "zod";
import { RipgrepNotFoundError } from "../ripgrep/service";
import type { RipgrepService } from "../ripgrep/service";
import type { ToolDescriptor, ToolExecutionContext } from "../types";

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
    agentName: "test-agent",
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
  let tool: ToolDescriptor;
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

    expect(tool.execute({ pattern: "*.ts" }, createMockCtx())).rejects.toThrow(RipgrepNotFoundError);
  });

  test("handles spawn error gracefully", async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("ENOENT: spawn rg ENOENT");
    });

    expect(tool.execute({ pattern: "*.ts" }, createMockCtx())).rejects.toThrow(/ENOENT/);
  });

  test("workspace guard denies path outside workspace", async () => {
    const guard = tool.guards![0];

    const decision = await guard({ pattern: "*.ts", path: "../outside" }, createMockCtx());
    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("outside");
  });

  test("workspace guard allows path within workspace", async () => {
    const guard = tool.guards![0];

    const decision = await guard({ pattern: "*.ts", path: "src/" }, createMockCtx());
    expect(decision.outcome).toBe("allow");
  });

  test("workspace guard allows when no path provided", async () => {
    const guard = tool.guards![0];

    const decision = await guard({ pattern: "*.ts" }, createMockCtx());
    expect(decision.outcome).toBe("allow");
  });
});
