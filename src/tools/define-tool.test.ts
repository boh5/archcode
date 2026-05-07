import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "./define-tool.js";
import type {
  ToolDescriptor,
  ToolExecutionContext,
} from "./types.js";

// Minimal mock for ToolExecutionContext
function mockCtx(): ToolExecutionContext {
  return {
    store: {} as any,
    toolName: "test",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
  };
}

describe("defineTool", () => {
  test("returns a ToolDescriptor with all fields preserved", () => {
    const schema = z.object({ path: z.string() }).strict();

    const descriptor = defineTool({
      name: "file_read",
      description: "Read file contents",
      inputSchema: schema,
      capabilities: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        return `contents of ${input.path}`;
      },
    });

    expect(descriptor.name).toBe("file_read");
    expect(descriptor.description).toBe("Read file contents");
    expect(descriptor.inputSchema).toBe(schema);
    expect(descriptor.capabilities).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(descriptor.hooks).toBeUndefined();
    expect(typeof descriptor.execute).toBe("function");
  });

  test("executor receives inferred input and returns string", async () => {
    const schema = z
      .object({ path: z.string(), encoding: z.string().optional() })
      .strict();

    const descriptor = defineTool({
      name: "file_read",
      description: "Read file",
      inputSchema: schema,
      capabilities: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        // input.path is inferred as string
        return `read: ${input.path}`;
      },
    });

    const result = await descriptor.execute(
      { path: "/tmp/test.txt" },
      mockCtx(),
    );
    expect(result).toBe("read: /tmp/test.txt");
  });

  test("preserves per-tool hooks", () => {
    const schema = z.object({ x: z.number() }).strict();
    const beforeFn = async (_input: unknown, _ctx: ToolExecutionContext) => {
      return { x: 42 };
    };
    const afterFn = async (
      result: { output: string; isError: boolean },
      _ctx: ToolExecutionContext,
    ) => {
      return { ...result, output: result.output.toUpperCase() };
    };

    const descriptor = defineTool({
      name: "compute",
      description: "Compute something",
      inputSchema: schema,
      capabilities: {
        readOnly: true,
        destructive: false,
        concurrencySafe: false,
      },
      hooks: {
        before: [beforeFn],
        after: [afterFn],
      },
      async execute(input, _ctx) {
        return `result: ${input.x}`;
      },
    });

    expect(descriptor.hooks?.before).toHaveLength(1);
    expect(descriptor.hooks?.after).toHaveLength(1);
    expect(descriptor.hooks?.before![0]).toBe(beforeFn);
    expect(descriptor.hooks?.after![0]).toBe(afterFn);
  });

  test("works with sync executor", async () => {
    const schema = z.object({ msg: z.string() }).strict();

    const descriptor = defineTool({
      name: "echo",
      description: "Echo input",
      inputSchema: schema,
      capabilities: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      execute(input, _ctx) {
        return input.msg;
      },
    });

    const result = await descriptor.execute({ msg: "hello" }, mockCtx());
    expect(result).toBe("hello");
  });

  test("executor can throw and error propagates", async () => {
    const schema = z.object({ path: z.string() }).strict();

    const descriptor = defineTool({
      name: "fail_tool",
      description: "Always fails",
      inputSchema: schema,
      capabilities: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(_input, _ctx) {
        throw new Error("tool failed");
      },
    });

    expect(
      descriptor.execute({ path: "/bad" }, mockCtx()),
    ).rejects.toThrow("tool failed");
  });

  test("compile-time: accessing non-existent property on input is rejected", () => {
    const schema = z.object({ path: z.string() }).strict();

    const _descriptor = defineTool({
      name: "type_check",
      description: "Type safety check",
      inputSchema: schema,
      capabilities: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        // @ts-expect-error — 'nonexistent' does not exist on '{ path: string }'
        return input.nonexistent;
      },
    });
  });

  test("returns a value assignable to ToolDescriptor", () => {
    const schema = z.object({ url: z.string() }).strict();

    const descriptor: ToolDescriptor<{ url: string }> = defineTool({
      name: "fetch",
      description: "Fetch URL",
      inputSchema: schema,
      capabilities: {
        readOnly: true,
        destructive: false,
        concurrencySafe: true,
      },
      async execute(input, _ctx) {
        return `fetched ${input.url}`;
      },
    });

    expect(descriptor.name).toBe("fetch");
  });
});
