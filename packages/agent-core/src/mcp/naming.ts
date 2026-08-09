import { createHash } from "node:crypto";
import { McpServerNameError, McpToolNameError } from "./errors";

export const MCP_ALIAS_MAX_LENGTH = 64;
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
export const MCP_DOUBLE_UNDERSCORE = /__/;

/** Config server names keep the strict hard-cut schema contract. */
export function validateMcpNameSegment(
  value: string,
  kind: "server" | "tool",
): void {
  const ErrorClass = kind === "server" ? McpServerNameError : McpToolNameError;
  if (value.length === 0) throw new ErrorClass(value, `${kind} name must not be empty`);
  if (MCP_DOUBLE_UNDERSCORE.test(value)) {
    throw new ErrorClass(value, `${kind} name must not contain consecutive underscores`);
  }
  if (!MCP_NAME_PATTERN.test(value)) {
    throw new ErrorClass(value, `${kind} name must match ${MCP_NAME_PATTERN.source}`);
  }
}

export function sanitizeMcpServerNameForRegistry(name: string): string {
  return sanitizeAliasSegment(name);
}

/**
 * Produce a provider-safe alias while preserving original identity separately
 * in the runtime inventory. Every alias includes an identity hash, so dots,
 * punctuation and truncation cannot silently rebind one tool to another.
 */
export function toMcpToolRegistryName(
  serverName: string,
  toolName: string,
  presentationToolName: string = toolName,
): string {
  validateMcpNameSegment(serverName, "server");
  if (toolName.length === 0) throw new McpToolNameError(toolName, "tool name must not be empty");

  const server = truncateCodePoints(sanitizeAliasSegment(serverName), 14);
  const tool = truncateCodePoints(sanitizeAliasSegment(presentationToolName), 21);
  const digest = createHash("sha256")
    .update(serverName)
    .update("\0")
    .update(toolName)
    .digest("hex")
    .slice(0, 20);
  const alias = `mcp__${server}__${tool}__${digest}`;
  if (alias.length > MCP_ALIAS_MAX_LENGTH) {
    throw new Error("MCP alias generation exceeded the provider name limit");
  }
  return alias;
}

function sanitizeAliasSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "tool";
}

function truncateCodePoints(value: string, maxLength: number): string {
  return [...value].slice(0, maxLength).join("");
}
