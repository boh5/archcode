import { McpServerNameError, McpToolNameError } from "./errors";

// ─── Constants ───

export const MCP_REGISTRY_SEPARATOR = "__";
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
export const MCP_DOUBLE_UNDERSCORE = /__/;

// ─── Validation ───

/**
 * Validate a name segment for an MCP server or tool.
 *
 * Rules:
 * - Must NOT be empty
 * - Must match `^[A-Za-z0-9_.-]+$`
 * - Must NOT contain consecutive underscores (`__`)
 *
 * Throws `McpServerNameError` or `McpToolNameError` on invalid input.
 */
export function validateMcpNameSegment(
  value: string,
  kind: "server" | "tool",
): void {
  const ErrorClass = kind === "server" ? McpServerNameError : McpToolNameError;

  if (value.length === 0) {
    throw new ErrorClass(value, `${kind} name must not be empty`);
  }

  if (MCP_DOUBLE_UNDERSCORE.test(value)) {
    throw new ErrorClass(
      value,
      `${kind} name must not contain consecutive underscores`,
    );
  }

  if (!MCP_NAME_PATTERN.test(value)) {
    throw new ErrorClass(
      value,
      `${kind} name must match ${MCP_NAME_PATTERN.source}`,
    );
  }
}

// ─── Registry Name Generation ───

/**
 * Build a globally-unique MCP tool registry name.
 *
 * Format: `mcp__{serverName}__{toolName}`
 *
 * Both segments are validated before joining.  Throws on invalid input.
 *
 * @example
 * toMcpToolRegistryName("context7", "resolve-library-id")
 * // => "mcp__context7__resolve-library-id"
 */
export function toMcpToolRegistryName(
  serverName: string,
  toolName: string,
): string {
  validateMcpNameSegment(serverName, "server");
  validateMcpNameSegment(toolName, "tool");
  return `mcp${MCP_REGISTRY_SEPARATOR}${serverName}${MCP_REGISTRY_SEPARATOR}${toolName}`;
}
