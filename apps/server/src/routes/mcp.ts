import { Hono } from "hono";
import type { AgentRuntime } from "@archcode/agent-core";
import type { McpServerStatus } from "@archcode/protocol";

/**
 * MCP routes. Mounted under `/api/mcp` so the MCP status endpoint is reachable
 * at `/api/mcp/status`.
 *
 * MCP status is runtime-global (not per-project); the route intentionally has no
 * `:slug` segment so clients can fetch the snapshot without a project context.
 */
export function createMcpRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/status", (c) => {
    const statuses = runtime.getMcpServerStatuses();
    const servers: Record<string, McpServerStatus> = {};
    for (const [name, status] of statuses) {
      servers[name] = status;
    }
    return c.json({ servers });
  });

  return app;
}