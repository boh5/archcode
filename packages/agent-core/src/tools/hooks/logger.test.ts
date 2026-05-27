import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Logger } from "../../logger";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createExecutionLogger } from "./logger";
import { REDACTION_MARKER } from "../security";
import { createTestProjectContext } from "../test-project-context";

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
    projectContext: createTestProjectContext("/tmp"),
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
    debug: ReturnType<typeof mock>;
    info: ReturnType<typeof mock>;
    warn: ReturnType<typeof mock>;
    error: ReturnType<typeof mock>;
    child: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    mockLogger = {
      debug: mock(),
      info: mock(),
      warn: mock(),
      error: mock(),
      child: mock(() => mockLogger as unknown as Logger),
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

  it("logs one debug call per tool execution with correct fields", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult({ output: "some output here", isError: false });
    const ctx = makeCtx({
      toolName: "bash",
      toolCallId: "call-xyz",
      durationMs: 150,
    });

    await hook(result, ctx);

    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    const callArgs = mockLogger.debug.mock.calls[0] as [string, { context: Record<string, unknown> }];

    // First arg is a message string
    expect(typeof callArgs[0]).toBe("string");
    // Second arg carries structured context.
    const meta = callArgs[1]!.context;
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

    const meta = (mockLogger.debug.mock.calls[0]! as [string, { context: Record<string, unknown> }])[1]!.context;
    expect(meta.outputSize).toBe(3);
  });

  it("logs isError true for error results", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult({ output: "error!", isError: true });
    const ctx = makeCtx();

    await hook(result, ctx);

    const meta = (mockLogger.debug.mock.calls[0]! as [string, { context: Record<string, unknown> }])[1]!.context;
    expect(meta.isError).toBe(true);
  });

  it("uses durationMs from context", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult();
    const ctx = makeCtx({ durationMs: 999 });

    await hook(result, ctx);

    const meta = (mockLogger.debug.mock.calls[0]! as [string, { context: Record<string, unknown> }])[1]!.context;
    expect(meta.durationMs).toBe(999);
  });

  it("handles missing durationMs gracefully", async () => {
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult();
    const ctx = makeCtx();
    ctx.durationMs = undefined;

    await hook(result, ctx);

    const meta = (mockLogger.debug.mock.calls[0]! as [string, { context: Record<string, unknown> }])[1]!.context;
    expect(meta.durationMs).toBeUndefined();
  });

  it("accepts custom logger", async () => {
    const customLogger: Logger = {
      debug: (msg, meta) => {
        mockLogger.debug(msg, meta);
      },
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => customLogger,
    };
    const hook = createExecutionLogger(customLogger);
    const result = makeResult({ output: "test" });
    const ctx = makeCtx();

    await hook(result, ctx);

    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    const meta = (mockLogger.debug.mock.calls[0]! as [string, { context: Record<string, unknown> }])[1]!.context;
    expect(meta.toolName).toBe("bash");
    expect(meta.outputSize).toBe(4);
  });

  it("uses the required debug method", async () => {
    const debug = mock(() => {});
    const logger: Logger = {
      debug,
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    const hook = createExecutionLogger(logger);
    const result = makeResult();
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it("logs only redacted input metadata", async () => {
    const rawSecret = "sk_test_1234567890abcdef";
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const ctx = makeCtx({
      input: { command: `token=${rawSecret}` },
      redactedInput: { command: `token=${REDACTION_MARKER}` },
    });

    await hook(makeResult(), ctx);

    const meta = (mockLogger.debug.mock.calls[0]! as [string, { context: Record<string, unknown> }])[1]!.context;
    expect(JSON.stringify(meta)).toContain(REDACTION_MARKER);
    expect(JSON.stringify(meta)).not.toContain(rawSecret);
  });
});
