import { describe, expect, test } from "bun:test";
import type {
  MaybePromise,
  ToolCapabilities,
  ToolExecutionResult,
  ToolExecutionContext,
  Logger,
  BeforeHook,
  AfterHook,
  ToolDescriptor,
  ToolCallLike,
} from "./types";
import { DuplicateToolError } from "./types";

// ─── DuplicateToolError ───

describe("DuplicateToolError", () => {
  test("has correct name property", () => {
    const error = new DuplicateToolError("read_file");
    expect(error.name).toBe("DuplicateToolError");
  });

  test("includes tool name in message", () => {
    const error = new DuplicateToolError("read_file");
    expect(error.message).toContain("read_file");
    expect(error.message.toLowerCase()).toContain("duplicate");
  });

  test("is instance of Error", () => {
    const error = new DuplicateToolError("bash");
    expect(error).toBeInstanceOf(Error);
  });
});

// ─── Compile-time type assertions ───

test("ToolCapabilities requires all fields at compile time", () => {
  // @ts-expect-error — missing `readOnly`
  const _bad1: ToolCapabilities = { destructive: false, concurrencySafe: true };

  // @ts-expect-error — missing `destructive`
  const _bad2: ToolCapabilities = { readOnly: true, concurrencySafe: false };

  // @ts-expect-error — missing `concurrencySafe`
  const _bad3: ToolCapabilities = { readOnly: true, destructive: false };

  // Valid — all fields present
  const _good: ToolCapabilities = {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  };

  expect(_good.readOnly).toBe(true);
});

test("ToolExecutionResult has required and optional fields", () => {
  // Minimal valid result
  const minimal: ToolExecutionResult = { output: "ok", isError: false };
  expect(minimal.output).toBe("ok");

  // With optional meta
  const withMeta: ToolExecutionResult = {
    output: "done",
    isError: false,
    meta: { tokens: 42 },
  };
  expect(withMeta.meta?.tokens).toBe(42);
});

test("ToolCallLike shape", () => {
  const call: ToolCallLike = {
    toolCallId: "call_123",
    toolName: "read_file",
    input: { path: "/tmp/a.txt" },
  };
  expect(call.toolCallId).toBe("call_123");
});

test("Logger methods are all optional", () => {
  // Empty logger is valid
  const empty: Logger = {};
  expect(empty).toBeDefined();

  // Full logger is valid
  const full: Logger = {
    debug: (_msg, _meta?) => {},
    info: (_msg, _meta?) => {},
    warn: (_msg, _meta?) => {},
  };
  expect(full).toBeDefined();
});

test("BeforeHook and AfterHook accept void return", () => {
  const beforeVoid: BeforeHook = (_input, _ctx) => {
    // returns void — means unchanged
  };
  const beforeReplace: BeforeHook = (_input, _ctx) => {
    return { modified: true };
  };
  const afterVoid: AfterHook = (_result, _ctx) => {
    // returns void — means unchanged
  };
  const afterReplace: AfterHook = (result, _ctx) => {
    return { ...result, output: "replaced" };
  };

  expect(beforeVoid).toBeDefined();
  expect(beforeReplace).toBeDefined();
  expect(afterVoid).toBeDefined();
  expect(afterReplace).toBeDefined();
});

test("ToolDescriptor requires all fields", () => {
  // @ts-expect-error — missing `capabilities`
  const _bad: ToolDescriptor = {
    name: "test",
    description: "A test tool",
    inputSchema: {} as any,
    execute: async (_input, _ctx) => "ok",
  };

  // Valid descriptor
  const _good: ToolDescriptor = {
    name: "test",
    description: "A test tool",
    inputSchema: {} as any,
    capabilities: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (_input, _ctx) => "ok",
  };

  expect(_good.name).toBe("test");
});
