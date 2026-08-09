import { apiFetch } from "./client";
import type {
  McpServerInventoryResponse,
  McpServerStatus,
  McpToolInventoryItem,
  UpdateServerConfigRequest,
} from "@archcode/protocol";

export type McpServerStatusMap = Record<string, McpServerStatus>;

export async function getMcpStatus(): Promise<McpServerStatusMap> {
  const res = await apiFetch<{ servers: McpServerStatusMap }>(
    "/api/mcp/status",
  );
  return res.servers;
}

export async function getMcpInventory(): Promise<McpServerInventoryResponse["servers"]> {
  const response = await apiFetch<McpServerInventoryResponse>("/api/mcp/inventory");
  return response.servers ?? {};
}

export interface McpDraftTestResponse {
  tools: McpToolInventoryItem[];
  warnings: string[];
}

export function testMcpDraft(serverName: string, request: UpdateServerConfigRequest): Promise<McpDraftTestResponse> {
  return apiFetch<McpDraftTestResponse>(`/api/mcp/test/${encodeURIComponent(serverName)}`, {
    method: "POST",
    body: request as unknown as Record<string, unknown>,
  });
}

export async function reconnectMcpServer(serverName: string): Promise<McpServerStatusMap> {
  return (await apiFetch<{ servers: McpServerStatusMap }>(`/api/mcp/reconnect/${encodeURIComponent(serverName)}`, {
    method: "POST",
  })).servers;
}
