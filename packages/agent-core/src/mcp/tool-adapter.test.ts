import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { REDACTION_MARKER, SecretRedactionPolicy } from "../security";
import type { RawToolResult, ToolExecutionContext } from "../tools/types";
import type { CallToolResultLike, McpClient } from "./client";
import { MAX_MCP_SERIALIZED_RESULT_BYTES, adaptMcpTool } from "./tool-adapter";

const POLICY = new SecretRedactionPolicy(["secret-token"]);

function makeClient(result: CallToolResultLike): McpClient {
  return { callTool: mock(async () => result) } as unknown as McpClient;
}

function throwingClient(error: unknown): McpClient {
  return {
    callTool: mock(async () => { throw error; }),
  } as unknown as McpClient;
}

function text(result: RawToolResult): string {
  if (result.draft.kind !== "text") throw new Error("Expected MCP text draft");
  return result.draft.text;
}

async function execute(
  descriptor: ReturnType<typeof adaptMcpTool>,
  input: Record<string, unknown> = {},
): Promise<RawToolResult> {
  return descriptor.execute(input, {} as ToolExecutionContext);
}

afterEach(() => mock.restore());

describe("adaptMcpTool", () => {
  test("declares the hard-cut artifact policy and preserves the MCP schema", () => {
    const descriptor = adaptMcpTool(
      {
        name: "resolve-library-id",
        description: "Resolve a library ID",
        inputSchema: {
          type: "object",
          properties: { libraryName: { type: "string" } },
          required: ["libraryName"],
        },
      },
      "context7",
      makeClient({ content: [] }),
      POLICY,
    );

    expect(descriptor.name).toBe("mcp__context7__resolve-library-id");
    expect(descriptor.description).toBe("Resolve a library ID");
    expect(descriptor.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(descriptor.aiInputSchema).toBeDefined();
    expect(descriptor.outputPolicy).toEqual({
      kind: "artifact",
      previewDirection: "head-tail",
    });
  });

  test("uses safe traits by default and serial destructive traits when annotated", () => {
    const safe = adaptMcpTool(
      { name: "read" }, "docs", makeClient({ content: [] }), POLICY,
    );
    const destructive = adaptMcpTool(
      { name: "delete", annotations: { readOnlyHint: true, destructiveHint: true } },
      "docs",
      makeClient({ content: [] }),
      POLICY,
    );

    expect(safe.traits).toEqual({ readOnly: true, destructive: false, concurrencySafe: true });
    expect(destructive.traits).toEqual({ readOnly: false, destructive: true, concurrencySafe: false });
    expect(destructive.permissions).toHaveLength(1);
  });

  test("calls the original MCP name and constructs a Raw text draft", async () => {
    const client = makeClient({ content: [{ type: "text", text: "ok" }] });
    const descriptor = adaptMcpTool(
      { name: "resolve-library-id" }, "context7", client, POLICY,
    );
    const input = { libraryName: "React" };
    const result = await execute(descriptor, input);

    expect(client.callTool).toHaveBeenCalledWith("resolve-library-id", input);
    expect(result).toEqual({ isError: false, draft: { kind: "text", text: "ok" } });
  });

  test("formats content in order and appends structured content", async () => {
    const descriptor = adaptMcpTool(
      { name: "query" },
      "docs",
      makeClient({
        content: [
          { type: "text", text: "summary" },
          { type: "image", mimeType: "image/png" },
        ],
        structuredContent: { ids: ["one"] },
      }),
      POLICY,
    );

    expect(text(await execute(descriptor))).toBe(
      'summary\n[Unsupported MCP content type: image]\nStructured content:\n{"ids":["one"]}',
    );
  });

  test("uses deterministic empty output", async () => {
    const descriptor = adaptMcpTool(
      { name: "empty" }, "docs", makeClient({ content: [] }), POLICY,
    );
    expect(text(await execute(descriptor))).toBe("MCP tool returned no content.");
  });

  test("turns MCP error results into bounded structured Raw errors", async () => {
    const descriptor = adaptMcpTool(
      { name: "fail" },
      "docs",
      makeClient({ content: [{ type: "text", text: "upstream failed" }], isError: true }),
      POLICY,
    );
    const result = await execute(descriptor);

    expect(result.isError).toBe(true);
    expect(result.details?.error).toMatchObject({
      kind: "execution",
      code: "TOOL_MCP_ERROR",
      name: "McpToolError",
    });
    expect(text(result)).toContain("upstream failed");
  });

  test("uses the shared runtime policy for thrown errors and logs", async () => {
    const descriptor = adaptMcpTool(
      { name: "fail" },
      "docs",
      throwingClient(new Error("bad token secret-token")),
      POLICY,
    );
    const result = await execute(descriptor);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(REDACTION_MARKER);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("converts non-serializable structured content into a tool error", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const descriptor = adaptMcpTool(
      { name: "circular" },
      "docs",
      makeClient({ content: [], structuredContent: circular }),
      POLICY,
    );
    const result = await execute(descriptor);

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_MCP_ERROR");
  });

  test("rejects escaped structured serialization that expands beyond 8 MiB", async () => {
    const descriptor = adaptMcpTool(
      { name: "expanded" },
      "server",
      makeClient({ content: [], structuredContent: { value: "\n".repeat(MAX_MCP_SERIALIZED_RESULT_BYTES / 2) } }),
      POLICY,
    );

    const result = await execute(descriptor);

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_MCP_ERROR");
    expect(result.draft.kind === "text" ? Buffer.byteLength(result.draft.text) : 0).toBeLessThan(4 * 1024);
  });

  test("rejects aggregate content blocks before join can create an oversized string", async () => {
    const descriptor = adaptMcpTool(
      { name: "many-blocks" },
      "server",
      makeClient({
        content: [
          { type: "text", text: "a".repeat(MAX_MCP_SERIALIZED_RESULT_BYTES / 2) },
          { type: "text", text: "b".repeat(MAX_MCP_SERIALIZED_RESULT_BYTES / 2) },
        ],
      }),
      POLICY,
    );

    const result = await execute(descriptor);

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_MCP_ERROR");
  });
});
