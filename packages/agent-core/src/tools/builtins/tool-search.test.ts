import { describe, expect, mock, test } from "bun:test";

import type { RawToolResult, ToolExecutionContext, ToolSearchResolution } from "../types";
import {
  TOOL_SEARCH_REDACTED_QUERY,
  TOOL_SEARCH_SENSITIVE_QUERY_CODE,
  ToolSearchInputSchema,
  toolSearchTool,
} from "./tool-search";

const DIGEST = "a".repeat(64);
const TOOL_DIGEST = "b".repeat(64);

function context(
  resolveToolSearch: (input: { query: string; namespace?: string; limit: number }) => Promise<ToolSearchResolution>,
  catalogDigest = DIGEST,
): ToolExecutionContext {
  return {
    toolSearchCatalogDigest: catalogDigest,
    resolveToolSearch,
  } as ToolExecutionContext;
}

async function execute(
  input: { query: string; namespace?: string; limit?: number },
  ctx: ToolExecutionContext,
): Promise<RawToolResult> {
  const parsed = ToolSearchInputSchema.parse(input);
  return await toolSearchTool.execute(parsed, ctx) as RawToolResult;
}

describe("tool_search", () => {
  test("loads bounded refs through a runtime-only sidecar for the next model step", async () => {
    const result = await execute({ query: "inspect syntax tree", limit: 1 }, context(async (input) => ({
      catalogDigest: DIGEST,
      namespaces: ["local.code"],
      matches: [{
        name: "ast_grep_search",
        namespace: "local.code",
        description: "Search source using syntax-aware patterns.",
        descriptorDigest: TOOL_DIGEST,
      }].slice(0, input.limit),
    })));

    expect(result.isError).toBe(false);
    expect(result.sidecar?.loadedToolRefs).toEqual([{ name: "ast_grep_search", descriptorDigest: TOOL_DIGEST }]);
    expect(result.draft).toMatchObject({ kind: "text" });
  });

  test("fails closed when the live authorized catalog changed", async () => {
    const result = await execute({ query: "search" }, context(async () => ({
      catalogDigest: "c".repeat(64),
      namespaces: ["local.code"],
      matches: [],
    })));

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ error: { code: "TOOL_SEARCH_CATALOG_CHANGED" } });
    expect(result.sidecar).toBeUndefined();
  });

  test("rejects secret-like queries before the resolver and returns a stable safe error", async () => {
    const resolveToolSearch = mock(async (): Promise<ToolSearchResolution> => ({
      catalogDigest: DIGEST,
      namespaces: [],
      matches: [],
    }));
    const secret = "api_key=sk_test_1234567890abcdef";
    const result = await execute({ query: secret }, context(resolveToolSearch));

    expect(resolveToolSearch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      details: { error: { code: TOOL_SEARCH_SENSITIVE_QUERY_CODE } },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(TOOL_SEARCH_REDACTED_QUERY);
  });

  test("returns a precise no-match error without loading a fallback", async () => {
    const result = await execute({ query: "nonexistent capability" }, context(async () => ({
      catalogDigest: DIGEST,
      namespaces: ["local.code", "mcp-docs"],
      matches: [],
    })));

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ error: { code: "TOOL_SEARCH_NO_MATCH" } });
    expect(result.sidecar).toBeUndefined();
  });

  test("is read-only, non-destructive, and serial", () => {
    expect(toolSearchTool.traits).toEqual({ readOnly: true, destructive: false, concurrencySafe: false });
    expect(toolSearchTool.description).toContain("select:<exact tool name>");
    expect(toolSearchTool.description).toContain("natural-language query only when no exact name can be chosen");
    expect(toolSearchTool.inputSchema.parse({ query: "web lookup" })).toEqual({ query: "web lookup", limit: 5 });
    expect(() => toolSearchTool.inputSchema.parse({ query: "web lookup", limit: 6 })).toThrow();
  });
});
