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

export async function getMcpInventory(
  options: { signal?: AbortSignal } = {},
): Promise<McpServerInventoryResponse["servers"]> {
  const response = await apiFetch<McpServerInventoryResponse>("/api/mcp/inventory", {
    signal: options.signal,
  });
  return response.servers ?? {};
}

export interface McpDraftTestResponse {
  tools: McpToolInventoryItem[];
  warnings: string[];
}

export function testMcpDraft(
  serverName: string,
  request: UpdateServerConfigRequest,
  options: { signal?: AbortSignal } = {},
): Promise<McpDraftTestResponse> {
  return apiFetch<McpDraftTestResponse>(`/api/mcp/test/${encodeURIComponent(serverName)}`, {
    method: "POST",
    body: request as unknown as Record<string, unknown>,
    signal: options.signal,
  });
}

export async function reconnectMcpServer(serverName: string): Promise<McpServerStatusMap> {
  return (await apiFetch<{ servers: McpServerStatusMap }>(`/api/mcp/reconnect/${encodeURIComponent(serverName)}`, {
    method: "POST",
  })).servers;
}
