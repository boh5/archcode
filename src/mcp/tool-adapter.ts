import { jsonSchema } from "ai";
import { z } from "zod";
import { defineTool } from "../tools/define-tool";
import { createToolErrorResult } from "../tools/errors";
import { REDACTION_MARKER } from "../tools/hooks/redact";
import type {
  AnyToolDescriptor,
  ToolExecutionResult,
  ToolTraits,
} from "../tools/types";
import type { CallToolResultLike, McpClient, McpToolLike } from "./client";
import { redactMcpMessage } from "./errors";
import { toMcpToolRegistryName } from "./naming";

const mcpToolInputSchema = z.object({}).catchall(z.unknown());
const EMPTY_MCP_RESULT = "MCP tool returned no content.";

// ─── Adapter ─────────────────────────────────────────────────────────────────

export function adaptMcpTool(
  mcpTool: McpToolLike,
  serverName: string,
  mcpClient: McpClient,
  secrets: Iterable<string>,
): AnyToolDescriptor {
  const toolName = mcpTool.name;

  return defineTool({
    name: toMcpToolRegistryName(serverName, toolName),
    description: mcpTool.description ?? fallbackDescription(serverName, toolName),
    inputSchema: mcpToolInputSchema,
    aiInputSchema: jsonSchema(mcpTool.inputSchema as Record<string, unknown>),
    traits: traitsFromAnnotations(mcpTool.annotations),
    async execute(input): Promise<ToolExecutionResult> {
      try {
        const result = await mcpClient.callTool(
          toolName,
          input as Record<string, unknown>,
        );
        const output = formatMcpResult(result);

        if (result.isError === true) {
          return createMcpErrorResult(serverName, toolName, output, secrets);
        }

        return { output, isError: false };
      } catch (err) {
        return createMcpErrorResult(
          serverName,
          toolName,
          errorMessage(err),
          secrets,
        );
      }
    },
  });
}

// ─── Traits ──────────────────────────────────────────────────────────────────

function traitsFromAnnotations(
  annotations: McpToolLike["annotations"],
): ToolTraits {
  const destructive = annotations?.destructiveHint === true;
  const readOnly = destructive
    ? false
    : typeof annotations?.readOnlyHint === "boolean"
      ? annotations.readOnlyHint
      : true;

  return {
    readOnly,
    destructive,
    concurrencySafe: !destructive,
  };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatMcpResult(result: CallToolResultLike): string {
  const lines = result.content.map(formatContentBlock);

  if (result.structuredContent !== undefined) {
    lines.push("Structured content:", stringifyStructuredContent(result.structuredContent));
  }

  const output = lines.join("\n").trim();
  return output.length > 0 ? output : EMPTY_MCP_RESULT;
}

function formatContentBlock(block: CallToolResultLike["content"][number]): string {
  if (block.type === "text") {
    return typeof block.text === "string" ? block.text : "";
  }

  return `[Unsupported MCP content type: ${block.type}]`;
}

function stringifyStructuredContent(content: unknown): string {
  try {
    const json = JSON.stringify(content);
    return json ?? "null";
  } catch {
    return String(content);
  }
}

function createMcpErrorResult(
  serverName: string,
  toolName: string,
  message: string,
  secrets: Iterable<string>,
): ToolExecutionResult {
  const redactedMessage = redactMcpMessage(message, secrets);
  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_MCP_ERROR",
    name: "McpToolError",
    message: `MCP tool error from server "${serverName}", tool "${toolName}": ${redactedMessage}`,
    hint: "Inspect the MCP tool error, adjust the input, then retry only if the tool call is still necessary.",
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown MCP tool error";
}

function fallbackDescription(serverName: string, toolName: string): string {
  return `MCP tool "${toolName}" from server "${serverName}".`;
}

// Keep the public redaction marker import visible to this adapter's dependency
// surface; callers/tests rely on the same marker used by MCP redaction helpers.
void REDACTION_MARKER;
