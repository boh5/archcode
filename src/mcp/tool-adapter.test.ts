import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { TOOL_ERROR_META_KEY, type FormattedToolError } from "../tools/errors";
import { REDACTION_MARKER } from "../tools/security";
import type { ToolExecutionContext, ToolExecutionResult } from "../tools/types";
import type { CallToolResultLike, McpClient } from "./client";
import { adaptMcpTool } from "./tool-adapter";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMcpClient(result: CallToolResultLike): McpClient {
  return {
    callTool: mock(async () => result),
  } as unknown as McpClient;
}

function makeThrowingMcpClient(error: unknown): McpClient {
  return {
    callTool: mock(async () => {
      throw error;
    }),
  } as unknown as McpClient;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: {} as ToolExecutionContext["store"],
    toolName: "mcp__context7__resolve-library-id",
    toolCallId: "call-1",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["mcp__context7__resolve-library-id"]),
    workspaceRoot: "/tmp",
    ...overrides,
  };
}

function toolError(result: { meta?: Record<string, unknown> }): FormattedToolError {
  return result.meta?.[TOOL_ERROR_META_KEY] as FormattedToolError;
}

function expectToolResult(result: string | ToolExecutionResult): ToolExecutionResult {
  expect(typeof result).not.toBe("string");
  return result as ToolExecutionResult;
}

afterEach(() => {
  mock.restore();
});

// ─── Descriptor Shape ────────────────────────────────────────────────────────

describe("adaptMcpTool descriptor", () => {
  test("converts an MCP tool into a Specra ToolDescriptor", () => {
    const descriptor = adaptMcpTool(
      {
        name: "resolve-library-id",
        description: "Resolve a library ID",
      },
      "context7",
      makeMcpClient({ content: [] }),
      [],
    );

    expect(descriptor.name).toBe("mcp__context7__resolve-library-id");
    expect(descriptor.description).toBe("Resolve a library ID");
    expect(descriptor.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(descriptor.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(typeof descriptor.execute).toBe("function");
  });

  test("aiInputSchema is set from MCP inputSchema for LLM visibility", () => {
    const descriptor = adaptMcpTool(
      {
        name: "resolve-library-id",
        description: "Resolve a library ID",
        inputSchema: {
          type: "object",
          properties: {
            libraryName: { type: "string", description: "Library name" },
            limit: { type: "number" },
          },
          required: ["libraryName"],
        },
      },
      "context7",
      makeMcpClient({ content: [] }),
      [],
    );

    // inputSchema remains the loose Zod schema for Specra's validation pipeline
    expect(descriptor.inputSchema).toBeInstanceOf(z.ZodObject);

    // aiInputSchema carries the real JSON Schema for the LLM
    expect(descriptor.aiInputSchema).toBeDefined();
    // jsonSchema() returns an AI SDK Schema object with a jsonSchema property
    const schema = descriptor.aiInputSchema as { jsonSchema: unknown };
    expect(schema).toHaveProperty("jsonSchema");
    const json = schema.jsonSchema as Record<string, unknown>;
    expect(json).toHaveProperty("properties");
    expect(json).toHaveProperty("required");
  });

  test("aiInputSchema falls back to empty object schema when MCP inputSchema is undefined", () => {
    const descriptor = adaptMcpTool(
      { name: "lookup" },
      "docs",
      makeMcpClient({ content: [] }),
      [],
    );

    // aiInputSchema should still be defined, with an empty object schema
    expect(descriptor.aiInputSchema).toBeDefined();
  });

  test("uses an English fallback description when missing", () => {
    const descriptor = adaptMcpTool(
      { name: "lookup" },
      "docs",
      makeMcpClient({ content: [] }),
      [],
    );

    expect(descriptor.description).toBe('MCP tool "lookup" from server "docs".');
  });

  test("input schema accepts arbitrary objects and rejects null arrays and primitives", () => {
    const descriptor = adaptMcpTool(
      { name: "lookup" },
      "docs",
      makeMcpClient({ content: [] }),
      [],
    );

    expect(descriptor.inputSchema.safeParse({}).success).toBe(true);
    expect(descriptor.inputSchema.safeParse({ query: "react", nested: { limit: 3 } }).success).toBe(true);
    expect(descriptor.inputSchema.safeParse(null).success).toBe(false);
    expect(descriptor.inputSchema.safeParse(["query"]).success).toBe(false);
    expect(descriptor.inputSchema.safeParse("query").success).toBe(false);
    expect(descriptor.inputSchema.safeParse(123).success).toBe(false);
    expect(descriptor.inputSchema.safeParse(true).success).toBe(false);
  });
});

// ─── Trait Mapping ───────────────────────────────────────────────────────────

describe("adaptMcpTool traits", () => {
  test("maps readOnlyHint=true to readOnly=true", () => {
    const descriptor = adaptMcpTool(
      { name: "read", annotations: { readOnlyHint: true } },
      "server",
      makeMcpClient({ content: [] }),
      [],
    );

    expect(descriptor.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
  });

  test("maps readOnlyHint=false to readOnly=false while remaining non-destructive", () => {
    const descriptor = adaptMcpTool(
      { name: "maybe-write", annotations: { readOnlyHint: false } },
      "server",
      makeMcpClient({ content: [] }),
      [],
    );

    expect(descriptor.traits).toEqual({
      readOnly: false,
      destructive: false,
      concurrencySafe: true,
    });
  });

  test("maps destructiveHint=true to destructive, non-readonly, serial traits", () => {
    const descriptor = adaptMcpTool(
      {
        name: "delete",
        annotations: { readOnlyHint: true, destructiveHint: true },
      },
      "server",
      makeMcpClient({ content: [] }),
      [],
    );

    expect(descriptor.traits).toEqual({
      readOnly: false,
      destructive: true,
      concurrencySafe: false,
    });
  });

  test("ignores destructiveHint=false and preserves explicit readOnlyHint=false", () => {
    const descriptor = adaptMcpTool(
      {
        name: "update-cache",
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      "server",
      makeMcpClient({ content: [] }),
      [],
    );

    expect(descriptor.traits).toEqual({
      readOnly: false,
      destructive: false,
      concurrencySafe: true,
    });
  });

  test("uses default safe traits when annotations are missing", () => {
    const descriptor = adaptMcpTool(
      { name: "list" },
      "server",
      makeMcpClient({ content: [] }),
      [],
    );

    expect(descriptor.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
  });
});

// ─── Execution And Formatting ────────────────────────────────────────────────

describe("adaptMcpTool execute", () => {
  test("calls MCP client with the original MCP tool name and parsed input", async () => {
    const client = makeMcpClient({ content: [{ type: "text", text: "ok" }] });
    const descriptor = adaptMcpTool(
      { name: "resolve-library-id" },
      "context7",
      client,
      [],
    );

    const input = { libraryName: "React", nested: { stable: true } };
    const result = await descriptor.execute(input, makeContext());

    expect(client.callTool).toHaveBeenCalledWith("resolve-library-id", input);
    expect(result).toEqual({ output: "ok", isError: false });
  });

  test("concatenates text blocks in MCP content order", async () => {
    const descriptor = adaptMcpTool(
      { name: "read" },
      "server",
      makeMcpClient({
        content: [
          { type: "text", text: "first" },
          { type: "image", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
      }),
      [],
    );

    const result = expectToolResult(await descriptor.execute({}, makeContext()));

    expect(result).toEqual({
      output: "first\n[Unsupported MCP content type: image]\nsecond",
      isError: false,
    });
  });

  test("represents structuredContent after text blocks", async () => {
    const descriptor = adaptMcpTool(
      { name: "query" },
      "server",
      makeMcpClient({
        content: [{ type: "text", text: "summary" }],
        structuredContent: { ids: ["/vercel/next.js"], count: 1 },
      }),
      [],
    );

    const result = expectToolResult(await descriptor.execute({}, makeContext()));

    expect(result).toEqual({
      output: 'summary\nStructured content:\n{"ids":["/vercel/next.js"],"count":1}',
      isError: false,
    });
  });

  test("returns fallback output for empty MCP results", async () => {
    const descriptor = adaptMcpTool(
      { name: "empty" },
      "server",
      makeMcpClient({ content: [] }),
      [],
    );

    const result = expectToolResult(await descriptor.execute({}, makeContext()));

    expect(result).toEqual({
      output: "MCP tool returned no content.",
      isError: false,
    });
  });

  test("formats circular structuredContent without throwing", async () => {
    const circular: Record<string, unknown> = { label: "root" };
    circular.self = circular;
    const descriptor = adaptMcpTool(
      { name: "circular" },
      "server",
      makeMcpClient({ content: [], structuredContent: circular }),
      [],
    );

    const result = expectToolResult(await descriptor.execute({}, makeContext()));

    expect(result.isError).toBe(false);
    expect(result.output).toBe("Structured content:\n[object Object]");
  });

  test("returns Specra tool error result when MCP result isError=true", async () => {
    const descriptor = adaptMcpTool(
      { name: "fail" },
      "server",
      makeMcpClient({
        content: [{ type: "text", text: "upstream failed" }],
        isError: true,
      }),
      [],
    );

    const result = expectToolResult(await descriptor.execute({}, makeContext()));

    expect(result.isError).toBe(true);
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(toolError(result).message).toBe(
      'MCP tool error from server "server", tool "fail": upstream failed',
    );
  });

  test("returns redacted Specra tool error result when MCP client throws", async () => {
    const descriptor = adaptMcpTool(
      { name: "fail" },
      "server",
      makeThrowingMcpClient(new Error("bad token secret-token")),
      ["secret-token"],
    );

    const result = expectToolResult(await descriptor.execute({}, makeContext()));

    expect(result.isError).toBe(true);
    expect(result.output).toContain(REDACTION_MARKER);
    expect(result.output).not.toContain("secret-token");
    expect(toolError(result).message).toBe(
      `MCP tool error from server "server", tool "fail": bad token ${REDACTION_MARKER}`,
    );
  });

  test("handles non-Error thrown values as tool execution errors", async () => {
    const descriptor = adaptMcpTool(
      { name: "fail" },
      "server",
      makeThrowingMcpClient("plain failure"),
      [],
    );

    const result = expectToolResult(await descriptor.execute({}, makeContext()));

    expect(result.isError).toBe(true);
    expect(toolError(result).message).toBe(
      'MCP tool error from server "server", tool "fail": plain failure',
    );
  });
});
