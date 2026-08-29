import { TOOL_SEARCH_SELECT_PREFIX, TOOL_TOOL_SEARCH } from "@archcode/protocol";
import { z } from "zod";

import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import { containsSecretPattern } from "../../security/patterns";
import type { RawToolResult } from "../types";

const MAX_QUERY_BYTES = 2_048;

/** Stable input stored when a model tries to put a secret-like value in a search query. */
export const TOOL_SEARCH_REDACTED_QUERY = "[REDACTED:TOOL_SEARCH_QUERY]";
export const TOOL_SEARCH_SENSITIVE_QUERY_CODE = "TOOL_SEARCH_SENSITIVE_QUERY";
export const TOOL_SEARCH_SENSITIVE_QUERY_MESSAGE =
  "Tool search queries must not contain secret-like values. Remove the sensitive value and retry.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Detects the query field, including malformed string input before schema validation. */
export function hasSensitiveToolSearchQuery(input: unknown): boolean {
  if (typeof input === "string") return containsSecretPattern(input).found;
  if (!isRecord(input) || typeof input.query !== "string") return false;
  return containsSecretPattern(input.query).found;
}

/** Replaces a rejected query before it can enter Session persistence or SSE. */
export function sanitizeToolSearchInput(input: unknown): unknown {
  return hasSensitiveToolSearchQuery(input) ? { query: TOOL_SEARCH_REDACTED_QUERY } : input;
}

/** Identifies the non-searchable durable marker produced by sanitizeToolSearchInput(). */
export function isRejectedToolSearchInput(input: unknown): boolean {
  return isRecord(input) && input.query === TOOL_SEARCH_REDACTED_QUERY;
}

export function createSensitiveToolSearchQueryResult(): RawToolResult {
  return createToolErrorResult({
    kind: "execution",
    code: TOOL_SEARCH_SENSITIVE_QUERY_CODE,
    message: TOOL_SEARCH_SENSITIVE_QUERY_MESSAGE,
  });
}

export const ToolSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).refine(
    (value) => new TextEncoder().encode(value).byteLength <= MAX_QUERY_BYTES,
    "query must be at most 2 KiB UTF-8",
  ).describe(`Use ${TOOL_SEARCH_SELECT_PREFIX}<exact tool name> when the deferred directory provides a name; otherwise use a natural-language capability query.`),
  namespace: z.string().trim().min(1).max(160).optional()
    .describe("Optional namespace or MCP server id to restrict the search."),
  limit: z.number().int().min(1).max(5).default(5)
    .describe("Number of keyword matches to load (1-5, default 5); ignored for exact select queries."),
});

export const toolSearchTool = defineTool({
  name: TOOL_TOOL_SEARCH,
  description: `Load tools from the current Agent's authorized deferred catalog. Prefer ${TOOL_SEARCH_SELECT_PREFIX}<exact tool name> from the deferred directory; use a natural-language query only when no exact name can be chosen. Matching full tool schemas become available on the next model step of this Execution.`,
  inputSchema: ToolSearchInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  prepareInput(input) {
    return sanitizeToolSearchInput(input);
  },
  async execute(input, ctx): Promise<RawToolResult> {
    if (hasSensitiveToolSearchQuery(input) || isRejectedToolSearchInput(input)) {
      return createSensitiveToolSearchQueryResult();
    }
    if (ctx.resolveToolSearch === undefined || ctx.toolSearchCatalogDigest === undefined) {
      return createToolErrorResult({
        kind: "execution",
        code: "TOOL_SEARCH_UNAVAILABLE",
        message: "Tool search is unavailable for this execution",
      });
    }

    const resolved = await ctx.resolveToolSearch(input);
    if (resolved.catalogDigest !== ctx.toolSearchCatalogDigest) {
      return createToolErrorResult({
        kind: "execution",
        code: "TOOL_SEARCH_CATALOG_CHANGED",
        message: "The authorized tool catalog changed after this model step; search again on the next step",
      });
    }
    if (resolved.matches.length === 0) {
      const namespaces = resolved.namespaces.length === 0 ? "none" : resolved.namespaces.join(", ");
      return createToolErrorResult({
        kind: "execution",
        code: "TOOL_SEARCH_NO_MATCH",
        message: `No authorized deferred tool matched the query. Available namespaces: ${namespaces}`,
      });
    }

    const loadedToolRefs = resolved.matches.map((match) => ({
      name: match.name,
      descriptorDigest: match.descriptorDigest,
    }));
    return {
      ...createTextToolResult(JSON.stringify({
        loaded: resolved.matches.map(({ name, namespace, description }) => ({ name, namespace, description })),
        availableNextStep: true,
      })),
      sidecar: { loadedToolRefs },
    };
  },
});
