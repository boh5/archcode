import type { ToolPermission, PermissionDecision, ToolExecutionContext } from "../types";

export function createMcpDestructivePermission(serverName: string, toolName: string): ToolPermission {
  return (_input: unknown, _ctx: ToolExecutionContext): PermissionDecision => {
    return {
      outcome: "ask",
      reason: `MCP tool "${toolName}" from server "${serverName}" is marked as destructive and requires confirmation.`,
      prompt: `Allow destructive MCP tool "${toolName}" from server "${serverName}" to run?`,
    };
  };
}