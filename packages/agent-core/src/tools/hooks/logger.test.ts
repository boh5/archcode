import { describe, expect, it } from "bun:test";
import { storeManager } from "../../store/store";
import type { Logger } from "../../logger";
import { createMockLogger } from "../../logger.test-helper";
import { createMockStore } from "../../store/test-helpers";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createExecutionLogger } from "./logger";
import { createTestProjectContext } from "../test-project-context";

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: overrides.store ?? createMockStore({ sessionId: "session-123" }),
  toolName: overrides.toolName ?? "bash",
  toolCallId: overrides.toolCallId ?? "call-abc-123",
  input: overrides.input ?? { command: "echo hello" },
  step: overrides.step ?? 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  durationMs: overrides.durationMs ?? 42,
  allowedTools: new Set<string>(),
  cwd: "/tmp",
  storeManager,
    projectContext: createTestProjectContext("/tmp"), ...overrides,  };
}

function makeResult(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    output: overrides.output ?? "hello world",
    isError: overrides.isError ?? false,
    meta: overrides.meta ?? {},
  };
}

describe("createExecutionLogger", () => {
  it("returns an AfterHook function", () => {
    const hook = createExecutionLogger(createMockLogger());
    expect(typeof hook).toBe("function");
  });

  it("returns void (does not modify result)", async () => {
    const mockLogger = createMockLogger();
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult();
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
  });

  it("logs one debug call per tool execution with correct fields", async () => {
    const mockLogger = createMockLogger();
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult({ output: "some output here", isError: false });
    const ctx = makeCtx({
      toolName: "bash",
      toolCallId: "call-xyz",
      durationMs: 150,
      agentName: "engineer",
      permissionOutcome: "allow",
    });

    await hook(result, ctx);

    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    const callArgs = mockLogger.debug.mock.calls[0] as [string, { context: Record<string, unknown>; meta: Record<string, unknown> }];

    expect(callArgs[0]).toBe("tool.execute.completed");
    expect(callArgs[1]!.context).toEqual({ sessionId: "session-123", agentName: "engineer" });
    const meta = callArgs[1]!.meta;
    expect(meta.toolName).toBe("bash");
    expect(meta.toolCallId).toBe("call-xyz");
    expect(meta.isError).toBe(false);
    expect(meta.outputSize).toBe("some output here".length);
    expect(meta.durationMs).toBe(150);
    expect(meta.step).toBe(1);
    expect(meta.permissionOutcome).toBe("allow");
    expect(Object.keys(meta).sort()).toEqual([
      "durationMs",
      "isError",
      "outputSize",
      "permissionOutcome",
      "step",
      "toolCallId",
      "toolName",
    ]);
    expect("input" in meta).toBe(false);
    expect("redactedInput" in meta).toBe(false);
    expect("output" in meta).toBe(false);
    expect("rawOutput" in meta).toBe(false);
  });

  it("logs output size as length of output string", async () => {
    const mockLogger = createMockLogger();
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult({ output: "abc" });
    const ctx = makeCtx();

    await hook(result, ctx);

    const meta = (mockLogger.debug.mock.calls[0]! as [string, { meta: Record<string, unknown> }])[1]!.meta;
    expect(meta.outputSize).toBe(3);
  });

  it("logs isError true for error results", async () => {
    const mockLogger = createMockLogger();
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult({ output: "error!", isError: true });
    const ctx = makeCtx();

    await hook(result, ctx);

    const meta = (mockLogger.debug.mock.calls[0]! as [string, { meta: Record<string, unknown> }])[1]!.meta;
    expect(meta.isError).toBe(true);
  });

  it("uses durationMs from context", async () => {
    const mockLogger = createMockLogger();
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult();
    const ctx = makeCtx({ durationMs: 999 });

    await hook(result, ctx);

    const meta = (mockLogger.debug.mock.calls[0]! as [string, { meta: Record<string, unknown> }])[1]!.meta;
    expect(meta.durationMs).toBe(999);
  });

  it("handles missing durationMs gracefully", async () => {
    const mockLogger = createMockLogger();
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const result = makeResult();
    const ctx = makeCtx();
    ctx.durationMs = undefined;

    await hook(result, ctx);

    const meta = (mockLogger.debug.mock.calls[0]! as [string, { meta: Record<string, unknown> }])[1]!.meta;
    expect("durationMs" in meta).toBe(false);
  });

  it("accepts custom logger", async () => {
    const mockLogger = createMockLogger();
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
    const meta = (mockLogger.debug.mock.calls[0]! as [string, { meta: Record<string, unknown> }])[1]!.meta;
    expect(meta.toolName).toBe("bash");
    expect(meta.outputSize).toBe(4);
  });

  it("uses the required debug method", async () => {
    const logger = createMockLogger();
    const hook = createExecutionLogger(logger);
    const result = makeResult();
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not log raw or redacted input/output fields", async () => {
    const mockLogger = createMockLogger();
    const rawSecret = "sk_test_1234567890abcdef";
    const hook = createExecutionLogger(mockLogger as unknown as Logger);
    const ctx = makeCtx({
      input: { command: `token=${rawSecret}` },
      redactedInput: { command: "token=[REDACTED]" },
    });

    await hook(makeResult({ output: `result ${rawSecret}` }), ctx);

    const fields = (mockLogger.debug.mock.calls[0]! as [string, { context: Record<string, unknown>; meta: Record<string, unknown> }])[1]!;
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain("[REDACTED]");
    expect(fields.meta.input).toBeUndefined();
    expect(fields.meta.redactedInput).toBeUndefined();
    expect(fields.meta.output).toBeUndefined();
    expect(fields.meta.rawOutput).toBeUndefined();
  });
});
