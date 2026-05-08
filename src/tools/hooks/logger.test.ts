import { beforeEach, describe, expect, it, jest } from "bun:test";
import type { Logger, ToolExecutionContext, ToolExecutionResult } from "../types";
import { createExecutionLogger } from "./logger.js";

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: {} as ToolExecutionContext["store"],
    toolName: overrides.toolName ?? "bash",
    toolCallId: overrides.toolCallId ?? "call-abc-123",
    input: overrides.input ?? { command: "echo hello" },
    step: overrides.step ?? 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    durationMs: overrides.durationMs ?? 42,
    allowedTools: new Set<string>(),
    workspaceRoot: "/tmp",
    ...overrides,
  };
}

function makeResult(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    output: overrides.output ?? "hello world",
    isError: overrides.isError ?? false,
    meta: overrides.meta ?? {},
  };
}

describe("createExecutionLogger", () => {
  let mockLogger: {
    debug: jest.Mock;
    info: jest.Mock;
    warn: jest.Mock;
  };

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    };
  });

  it("returns an AfterHook function", () => {
    const hook = createExecutionLogger();
    expect(typeof hook).toBe("function");
  });

  it("returns void (does not modify result)", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult();
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
  });

  it("logs one info call per tool execution with correct fields", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult({ output: "some output here", isError: false });
    const ctx = makeCtx({
      toolName: "bash",
      toolCallId: "call-xyz",
      durationMs: 150,
    });

    await hook(result, ctx);

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const callArgs = mockLogger.info.mock.calls[0] as [string, Record<string, unknown>];

    // First arg is a message string
    expect(typeof callArgs[0]).toBe("string");
    // Second arg is meta object
    const meta = callArgs[1]!;
    expect(meta.toolName).toBe("bash");
    expect(meta.toolCallId).toBe("call-xyz");
    expect(meta.isError).toBe(false);
    expect(meta.outputSize).toBe("some output here".length);
    expect(meta.durationMs).toBe(150);
  });

  it("logs output size as length of output string", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult({ output: "abc" });
    const ctx = makeCtx();

    await hook(result, ctx);

    const meta = (mockLogger.info.mock.calls[0]! as [string, Record<string, unknown>])[1]!;
    expect(meta.outputSize).toBe(3);
  });

  it("logs isError true for error results", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult({ output: "error!", isError: true });
    const ctx = makeCtx();

    await hook(result, ctx);

    const meta = (mockLogger.info.mock.calls[0]! as [string, Record<string, unknown>])[1]!;
    expect(meta.isError).toBe(true);
  });

  it("uses durationMs from context", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult();
    const ctx = makeCtx({ durationMs: 999 });

    await hook(result, ctx);

    const meta = (mockLogger.info.mock.calls[0]! as [string, Record<string, unknown>])[1]!;
    expect(meta.durationMs).toBe(999);
  });

  it("handles missing durationMs gracefully", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult();
    const ctx = makeCtx();
    ctx.durationMs = undefined;

    await hook(result, ctx);

    const meta = (mockLogger.info.mock.calls[0]! as [string, Record<string, unknown>])[1]!;
    expect(meta.durationMs).toBeUndefined();
  });

  it("accepts custom logger", async () => {
    const customLogger: Logger = {
      info: (msg, meta) => {
        mockLogger.info(msg, meta);
      },
    };
    const hook = createExecutionLogger(customLogger);
    const result = makeResult({ output: "test" });
    const ctx = makeCtx();

    await hook(result, ctx);

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const meta = (mockLogger.info.mock.calls[0]! as [string, Record<string, unknown>])[1]!;
    expect(meta.toolName).toBe("bash");
    expect(meta.outputSize).toBe(4);
  });

  it("does not throw when logger has no info method", async () => {
    // Logger interface has optional methods
    const loggerWithoutInfo: Logger = {};
    const hook = createExecutionLogger(loggerWithoutInfo);
    const result = makeResult();
    const ctx = makeCtx();

    // Should not throw
    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
  });
});
