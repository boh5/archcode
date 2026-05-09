import { REDACTION_MARKER } from "../tools/hooks/redact";

// ─── Error Classes ───

export class McpServerNameError extends Error {
  constructor(
    public readonly value: string,
    public readonly reason: string,
  ) {
    super(`Invalid MCP server name "${value}": ${reason}`);
    this.name = "McpServerNameError";
  }
}

export class McpToolNameError extends Error {
  constructor(
    public readonly value: string,
    public readonly reason: string,
  ) {
    super(`Invalid MCP tool name "${value}": ${reason}`);
    this.name = "McpToolNameError";
  }
}

export class McpDuplicateToolError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly toolName: string,
    public readonly registryName: string,
  ) {
    super(
      `Duplicate tool "${toolName}" in server "${serverName}" (registry: "${registryName}")`,
    );
    this.name = "McpDuplicateToolError";
  }
}

export class McpConnectionError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly cause?: unknown,
  ) {
    const msg =
      cause instanceof Error
        ? `MCP connection failed for server "${serverName}": ${cause.message}`
        : `MCP connection failed for server "${serverName}"`;
    super(msg);
    this.name = "McpConnectionError";
  }
}

export class McpToolExecutionError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly toolName: string,
    public readonly cause?: unknown,
  ) {
    const msg =
      cause instanceof Error
        ? `MCP tool execution failed for "${serverName}.${toolName}": ${cause.message}`
        : `MCP tool execution failed for "${serverName}.${toolName}"`;
    super(msg);
    this.name = "McpToolExecutionError";
  }
}

// ─── Warning Type ───

export interface McpWarning {
  serverName?: string;
  toolName?: string;
  message: string;
}

// ─── Redaction ───

/**
 * Replace all occurrences of any secret in the set within `message`
 * with the standard `REDACTION_MARKER`.
 *
 * Empty-string secrets are silently ignored to avoid corrupting all messages.
 */
export function redactMcpMessage(
  message: string,
  secrets: Iterable<string>,
): string {
  let result = message;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    result = result.replaceAll(secret, REDACTION_MARKER);
  }
  return result;
}
