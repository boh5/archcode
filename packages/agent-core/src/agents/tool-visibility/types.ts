import type { AnyToolDescriptor } from "../../tools/types";
import type { LoadedToolRef } from "@archcode/protocol";

export type { LoadedToolRef } from "@archcode/protocol";

export const TOOL_SEARCH_NAME = "tool_search";
export const MAX_TOOL_SEARCH_RESULTS = 5;

export type ToolSourceKind = "builtin" | "worktree" | "overlay" | "mcp";

export interface ToolCatalogInput {
  readonly sourceKind: ToolSourceKind;
  /** Local grouping name or the MCP server id. Never pass MCP display metadata here. */
  readonly namespace: string;
  readonly registryName: string;
  readonly descriptor: AnyToolDescriptor;
}

export interface ToolCatalogEntry {
  readonly sourceKind: ToolSourceKind;
  readonly namespace: string;
  readonly registryName: string;
  readonly description: string;
  readonly aiJsonSchema: unknown;
  readonly descriptorDigest: string;
  readonly descriptor: AnyToolDescriptor;
  /** Normalized search document. It contains no execution handle or secret configuration. */
  readonly searchText: string;
}

export interface ToolCatalog {
  readonly entries: readonly ToolCatalogEntry[];
  readonly digest: string;
}

export interface InvalidLoadedToolRef extends LoadedToolRef {
  readonly reason: "missing" | "digest_changed" | "tool_search_excluded";
}

export interface ToolSearchQuery {
  /** A select:<registryName> query bypasses ranking and loads one exact deferred entry. */
  readonly query: string;
  readonly namespace?: string;
  readonly limit?: number;
}

export interface ToolSearchResult {
  readonly name: string;
  readonly namespace: string;
  readonly description: string;
  readonly descriptorDigest: string;
  readonly score: number;
}
