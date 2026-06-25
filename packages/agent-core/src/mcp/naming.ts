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

// ─── Registry Name Sanitization ───

/**
 * Sanitize an MCP name segment for use in the tool registry name.
 *
 * Replaces any character NOT matching `[A-Za-z0-9_-]` with `_` so the
 * generated registry name satisfies the OpenAI-compatible provider
 * tool/function name constraint `^[a-zA-Z0-9_-]{1,64}$`. Deterministic:
 * same input → same output, so `factoryResolveAllowedTools` can compute
 * the matching prefix from the user-facing config name.
 *
 * Only affects the OUTPUT (registry name). Config validation
 * (`validateMcpNameSegment`) remains permissive and still allows `.`.
 */
export function sanitizeMcpServerNameForRegistry(name: string): string {
  return name.replace(new RegExp("[^A-Za-z0-9_-]", "g"), "_");
}

// ─── Registry Name Generation ───

/**
 * Build a globally-unique MCP tool registry name.
 *
 * Format: `mcp__{serverName}__{toolName}`
 *
 * Both segments are validated before joining, then sanitized so the result
 * satisfies the OpenAI-compatible provider tool/function name constraint
 * `^[a-zA-Z0-9_-]{1,64}$` (dots and other unsafe chars become `_`).
 * Throws on invalid input.
 *
 * @example
 * toMcpToolRegistryName("context7", "resolve-library-id")
 * // => "mcp__context7__resolve-library-id"
 *
 * @example
 * toMcpToolRegistryName("grep.app", "search")
 * // => "mcp__grep_app__search"
 */
export function toMcpToolRegistryName(
  serverName: string,
  toolName: string,
): string {
  validateMcpNameSegment(serverName, "server");
  validateMcpNameSegment(toolName, "tool");
  const safeServer = sanitizeMcpServerNameForRegistry(serverName);
  const safeTool = sanitizeMcpServerNameForRegistry(toolName);
  return `mcp${MCP_REGISTRY_SEPARATOR}${safeServer}${MCP_REGISTRY_SEPARATOR}${safeTool}`;
}
