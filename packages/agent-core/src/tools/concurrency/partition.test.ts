import { afterAll, describe, test, expect } from "bun:test";
import type { ToolCallLike } from "../types";
import { partitionToolCalls } from "./partition";
import type { ToolDescriptor } from "../types";
import { adaptMcpTool } from "../../mcp/tool-adapter";
import type { McpClient } from "../../mcp/client";
import { SecretRedactionPolicy } from "../../security";
import { createTextToolResult } from "../results";
import { createTestToolRegistryFixture } from "../test-registry";

const TEST_REDACTION_POLICY = new SecretRedactionPolicy([]);

function makeToolDescriptor(
  name: string,
  concurrencySafe: boolean,
): ToolDescriptor {
  const destructive = !concurrencySafe;
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
    traits: {
      readOnly: concurrencySafe,
      destructive,
      concurrencySafe,
    },
    ...(destructive ? { permissions: [async () => ({ outcome: "allow" })] } : {}),
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async () => createTextToolResult(""),
  };
}

function makeCall(toolName: string, toolCallId?: string): ToolCallLike {
  return { toolCallId: toolCallId ?? toolName, toolName, input: {} };
}

function makeMcpClient(): McpClient {
  return {
    callTool: async () => ({ content: [] }),
  } as unknown as McpClient;
}

describe("partitionToolCalls", () => {
  const safeTool = makeToolDescriptor("read_tool", true);
  const unsafeTool = makeToolDescriptor("write_tool", false);

  const registryFixture = createTestToolRegistryFixture({ descriptors: [safeTool, unsafeTool] });
  const registry = registryFixture.registry;
  afterAll(() => registryFixture.dispose());

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

  test("MCP adapter traits make read-only tools parallel and destructive tools serial", async () => {
    const readDescriptor = adaptMcpTool(
      { name: "read", annotations: { readOnlyHint: true } },
      "docs",
      makeMcpClient(),
      TEST_REDACTION_POLICY,
    );
    const otherReadDescriptor = adaptMcpTool(
      { name: "lookup" },
      "docs",
      makeMcpClient(),
      TEST_REDACTION_POLICY,
    );
    const destructiveDescriptor = adaptMcpTool(
      { name: "delete", annotations: { destructiveHint: true } },
      "docs",
      makeMcpClient(),
      TEST_REDACTION_POLICY,
    );
    const mcpFixture = createTestToolRegistryFixture({ descriptors: [
      readDescriptor,
      otherReadDescriptor,
      destructiveDescriptor,
    ] });
    const mcpRegistry = mcpFixture.registry;
    const calls = [
      makeCall("mcp__docs__read", "read-1"),
      makeCall("mcp__docs__lookup", "read-2"),
      makeCall("mcp__docs__delete", "delete-1"),
      makeCall("mcp__docs__read", "read-3"),
    ];

    expect(readDescriptor.traits).toMatchObject({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(destructiveDescriptor.traits).toMatchObject({
      readOnly: false,
      destructive: true,
      concurrencySafe: false,
    });
    expect(partitionToolCalls(calls, mcpRegistry)).toEqual([
      { type: "parallel", calls: [calls[0], calls[1]] },
      { type: "serial", call: calls[2] },
      { type: "parallel", calls: [calls[3]] },
    ]);
    await mcpFixture.dispose();
  });
});
