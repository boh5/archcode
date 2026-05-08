import { describe, test, expect } from "bun:test";
import type { z } from "zod";
import type { ToolCallLike } from "../types";
import type { ToolCallBatch } from "./partition";
import { partitionToolCalls } from "./partition";
import { createRegistry } from "../registry";
import type { ToolDescriptor } from "../types";

function makeToolDescriptor(
  name: string,
  concurrencySafe: boolean,
): ToolDescriptor {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
    traits: {
      readOnly: concurrencySafe,
      destructive: !concurrencySafe,
      concurrencySafe,
    },
    execute: async () => "",
  };
}

function makeCall(toolName: string, toolCallId?: string): ToolCallLike {
  return { toolCallId: toolCallId ?? toolName, toolName, input: {} };
}

describe("partitionToolCalls", () => {
  const safeTool = makeToolDescriptor("read_tool", true);
  const unsafeTool = makeToolDescriptor("write_tool", false);

  const registry = createRegistry([safeTool, unsafeTool]);

  test("all safe calls → one parallel batch", () => {
    const calls = [makeCall("read_tool", "a"), makeCall("read_tool", "b"), makeCall("read_tool", "c")];
    const result = partitionToolCalls(calls, registry);

    expect(result).toEqual([
      { type: "parallel", calls: [calls[0], calls[1], calls[2]] },
    ]);
  });

  test("all unsafe calls → each gets a serial batch", () => {
    const calls = [makeCall("write_tool", "a"), makeCall("write_tool", "b")];
    const result = partitionToolCalls(calls, registry);

    expect(result).toEqual([
      { type: "serial", call: calls[0] },
      { type: "serial", call: calls[1] },
    ]);
  });

  test("mixed calls produce alternating parallel/serial batches", () => {
    const calls = [
      makeCall("read_tool", "a"),
      makeCall("read_tool", "b"),
      makeCall("write_tool", "c"),
      makeCall("read_tool", "d"),
      makeCall("write_tool", "e"),
      makeCall("read_tool", "f"),
    ];
    const result = partitionToolCalls(calls, registry);

    expect(result).toEqual([
      { type: "parallel", calls: [calls[0], calls[1]] },
      { type: "serial", call: calls[2] },
      { type: "parallel", calls: [calls[3]] },
      { type: "serial", call: calls[4] },
      { type: "parallel", calls: [calls[5]] },
    ]);
  });

  test("unknown tool names → treated as serial", () => {
    const calls = [makeCall("unknown_tool", "a"), makeCall("read_tool", "b")];
    const result = partitionToolCalls(calls, registry);

    expect(result).toEqual([
      { type: "serial", call: calls[0] },
      { type: "parallel", calls: [calls[1]] },
    ]);
  });

  test("empty input → empty output", () => {
    const result = partitionToolCalls([], registry);
    expect(result).toEqual([]);
  });

  test("single safe call → one parallel batch with single call", () => {
    const calls = [makeCall("read_tool", "a")];
    const result = partitionToolCalls(calls, registry);

    expect(result).toEqual([
      { type: "parallel", calls: [calls[0]] },
    ]);
  });

  test("single unsafe call → one serial batch", () => {
    const calls = [makeCall("write_tool", "a")];
    const result = partitionToolCalls(calls, registry);

    expect(result).toEqual([
      { type: "serial", call: calls[0] },
    ]);
  });

  test("preserves toolCallId and input through batching", () => {
    const calls = [
      makeCall("read_tool", "custom-id-1"),
      makeCall("read_tool", "custom-id-2"),
    ];
    const result = partitionToolCalls(calls, registry);

    expect(result).toHaveLength(1);
    if (result[0].type === "parallel") {
      expect(result[0].calls[0].toolCallId).toBe("custom-id-1");
      expect(result[0].calls[1].toolCallId).toBe("custom-id-2");
      expect(result[0].calls[0].input).toEqual({});
      expect(result[0].calls[1].input).toEqual({});
    }
  });
});
