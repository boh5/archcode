import type { ResolvedMcpServerConfig } from "../config/mcp";
import type { BuiltinMcpServerName } from "@archcode/protocol";

/**
 * Built-in MCP server definitions.
 *
 * These curated servers are available by default without user configuration.
 * They use public endpoints with no API key required for basic use.
 *
 * Rate limits (as of 2026-05):
 * - context7: ~1000 requests/month without API key; free key at context7.com/dashboard for higher limits
 * - grep.app: no documented rate limit; fully free code search
 * - exa: ~150 requests/day unauthenticated; 3 QPS; paid plans for higher limits
 *
 * User configuration cannot override these reserved server names.
 */
export const BUILTIN_MCP_SERVERS: Record<BuiltinMcpServerName, ResolvedMcpServerConfig> = {
  context7: {
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    timeout: 30000,
  },
  "grep.app": {
    transport: "http",
    url: "https://mcp.grep.app",
    timeout: 30000,
  },
  exa: {
    transport: "http",
    url: "https://mcp.exa.ai/mcp",
    timeout: 30000,
  },
};
