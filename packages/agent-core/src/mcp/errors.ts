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
    public readonly reason: "aborted" | "timeout" | "failed" = "failed",
  ) {
    const outcome = reason === "aborted" ? "was aborted" : reason === "timeout" ? "timed out" : "failed";
    const msg =
      cause instanceof Error
        ? `MCP connection ${outcome} for server "${serverName}": ${cause.message}`
        : `MCP connection ${outcome} for server "${serverName}"`;
    super(msg);
    this.name = "McpConnectionError";
  }
}

export class McpToolExecutionError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly toolName: string,
    public readonly cause?: unknown,
    public readonly reason: "aborted" | "timeout" | "failed" = "failed",
  ) {
    const outcome = reason === "aborted" ? "was aborted" : reason === "timeout" ? "timed out" : "failed";
    const msg =
      cause instanceof Error
        ? `MCP tool execution ${outcome} for "${serverName}.${toolName}": ${cause.message}`
        : `MCP tool execution ${outcome} for "${serverName}.${toolName}"`;
    super(msg);
    this.name = "McpToolExecutionError";
  }
}
