import { apiFetch } from "./client";
import type { McpServerStatus } from "@archcode/protocol";

export type McpServerStatusMap = Record<string, McpServerStatus>;

export async function getMcpStatus(): Promise<McpServerStatusMap> {
  const res = await apiFetch<{ servers: McpServerStatusMap }>(
    "/api/mcp/status",
  );
  return res.servers;
}