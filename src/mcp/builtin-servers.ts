import type { ResolvedMcpServerConfig } from "../config/mcp";

/**
 * Built-in MCP server definitions.
 *
 * The MVP intentionally ships without real built-in remote servers. Future
 * versions can add curated entries here after product/security review, while
 * user-configured servers continue to work through the manager today.
 */
export const BUILTIN_MCP_SERVERS: Record<string, ResolvedMcpServerConfig> = {};
