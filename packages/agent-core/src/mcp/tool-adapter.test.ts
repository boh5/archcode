import { describe, expect, mock, test } from "bun:test";
import { SecretRedactionPolicy } from "../security";
import type { RawToolResult, ToolExecutionContext } from "../tools/types";
import type { McpClient, McpToolLike } from "./client";
import { McpToolExecutionError } from "./errors";
import { adaptMcpTool, traitsFromAnnotations, type McpCallHandle } from "./tool-adapter";

function handleWith(callTool: McpClient["callTool"]): { handle: McpCallHandle; release: ReturnType<typeof mock> } {
  const release = mock(() => undefined);
  const client = { callTool } as McpClient;
  return { handle: { tryAcquireCall: () => ({ client, release }) }, release };
}

function execute(descriptor: ReturnType<typeof adaptMcpTool>, signal = new AbortController().signal): Promise<RawToolResult> {
  return Promise.resolve(descriptor.execute(
    {},
    { abort: signal } as ToolExecutionContext,
  ));
}

describe("MCP tool adapter", () => {
  test("uses conservative annotation traits and never adds a permission", () => {
    const acquired = handleWith(mock(async () => ({ content: [] })));
    const descriptor = adaptMcpTool(
      { name: "delete.item", inputSchema: { type: "object" } },
      "docs",
      acquired.handle,
      new SecretRedactionPolicy([]),
    );
    expect(descriptor.traits).toEqual({ readOnly: false, destructive: true, concurrencySafe: false });
    expect(descriptor.permissions).toBeUndefined();
    expect(descriptor.outputPolicy).toEqual({ kind: "artifact", previewDirection: "head-tail" });
  });

  test("only explicit read-only annotations are concurrency safe", () => {
    expect(traitsFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(traitsFromAnnotations({ readOnlyHint: false, destructiveHint: false })).toEqual({
      readOnly: false,
      destructive: false,
      concurrencySafe: false,
    });
  });

  test("calls the original tool identity and redacts successful content", async () => {
    const callTool = mock(async (name: string) => ({
      content: [{ type: "text", text: `${name}: secret-value` }],
      structuredContent: { token: "secret-value" },
    }));
    const acquired = handleWith(callTool as McpClient["callTool"]);
    const descriptor = adaptMcpTool(
      { name: "lookup.tool", inputSchema: { type: "object" } },
      "docs",
      acquired.handle,
      new SecretRedactionPolicy(["secret-value"]),
    );
    const input = { nested: { enabled: true }, values: [1, "two", null] };
    const result = await Promise.resolve(descriptor.execute(
      input,
      { abort: new AbortController().signal } as ToolExecutionContext,
    ));
    expect(callTool).toHaveBeenCalledWith("lookup.tool", input, expect.any(AbortSignal), expect.any(Function));
    expect(result.draft.kind === "text" ? result.draft.text : "").toContain("[REDACTED:SECRET]");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(acquired.release).toHaveBeenCalledTimes(1);
  });

  test("fails deterministically when the bound handle retired before acquire", async () => {
    const descriptor = adaptMcpTool(
      { name: "lookup" },
      "docs",
      { tryAcquireCall: () => undefined },
      new SecretRedactionPolicy([]),
    );
    const result = await execute(descriptor);
    expect(result.details?.error?.code).toBe("TOOL_MCP_NOT_AVAILABLE");
  });

  test("effectful timeout is marked unknown while read-only timeout is not", async () => {
    const timeout = mock(async (
      _name: string,
      _input: Record<string, unknown>,
      _signal?: AbortSignal,
      onDispatch?: () => void,
    ) => {
      onDispatch?.();
      throw new McpToolExecutionError("docs", "work", new Error("timeout"), "timeout");
    }) as McpClient["callTool"];
    const effectful = adaptMcpTool(
      { name: "work" },
      "docs",
      handleWith(timeout).handle,
      new SecretRedactionPolicy([]),
    );
    const readOnly = adaptMcpTool(
      { name: "read", annotations: { readOnlyHint: true } },
      "docs",
      handleWith(timeout).handle,
      new SecretRedactionPolicy([]),
    );
    const effectfulResult = await execute(effectful);
    const readOnlyResult = await execute(readOnly);
    expect(effectfulResult.details?.error?.code).toBe("TOOL_MCP_CALL_TIMEOUT");
    expect(effectfulResult.details?.unknownResult).toBe(true);
    expect(readOnlyResult.details?.unknownResult).toBeUndefined();
  });

  test("pre-dispatch abort never acquires a handle", async () => {
    const tryAcquireCall = mock(() => undefined);
    const descriptor = adaptMcpTool(
      { name: "work" },
      "docs",
      { tryAcquireCall },
      new SecretRedactionPolicy([]),
    );
    const controller = new AbortController();
    controller.abort();
    const result = await execute(descriptor, controller.signal);
    expect(result.details?.error?.code).toBe("TOOL_MCP_CALL_ABORTED");
    expect(result.details?.unknownResult).toBeUndefined();
    expect(tryAcquireCall).not.toHaveBeenCalled();
  });

  test("cancellation before SDK dispatch is not marked as an uncertain effect", async () => {
    const callTool = mock(async (
      _name: string,
      _input: Record<string, unknown>,
      _signal?: AbortSignal,
      _onDispatch?: () => void,
    ) => {
      throw new McpToolExecutionError("docs", "work", new Error("aborted before dispatch"), "aborted");
    }) as McpClient["callTool"];
    const descriptor = adaptMcpTool(
      { name: "work" },
      "docs",
      handleWith(callTool).handle,
      new SecretRedactionPolicy([]),
    );

    const result = await execute(descriptor);

    expect(result.details?.error?.code).toBe("TOOL_MCP_CALL_ABORTED");
    expect(result.details?.unknownResult).toBeUndefined();
  });

  test("marks every post-dispatch effectful failure as an unknown result", async () => {
    const callTool = mock(async (
      _name: string,
      _input: Record<string, unknown>,
      _signal?: AbortSignal,
      onDispatch?: () => void,
    ) => {
      onDispatch?.();
      throw new McpToolExecutionError("docs", "work", new Error("connection reset"), "failed");
    }) as McpClient["callTool"];
    const descriptor = adaptMcpTool(
      { name: "work" },
      "docs",
      handleWith(callTool).handle,
      new SecretRedactionPolicy([]),
    );

    const result = await execute(descriptor);

    expect(result.details?.error?.code).toBe("TOOL_MCP_ERROR");
    expect(result.details?.unknownResult).toBe(true);
  });

  test("bounds invalid or cyclic structured results as tool errors", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const acquired = handleWith(mock(async () => ({ content: [], structuredContent: cyclic })) as McpClient["callTool"]);
    const descriptor = adaptMcpTool(
      { name: "lookup" } satisfies McpToolLike,
      "docs",
      acquired.handle,
      new SecretRedactionPolicy([]),
    );
    expect((await execute(descriptor)).details?.error?.code).toBe("TOOL_MCP_ERROR");
  });
});
