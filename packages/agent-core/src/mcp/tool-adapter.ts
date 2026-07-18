import { jsonSchema } from "ai";
import { z } from "zod";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { defineTool } from "../tools/define-tool";
import { createToolErrorResult } from "../tools/errors";
import { createTextToolResult } from "../tools/results";
import { createMcpDestructivePermission } from "../tools/permission";
import type { SecretRedactionPolicy } from "../security";
import type {
  AnyToolDescriptor,
  RawToolResult,
  ToolTraits,
} from "../tools/types";
import {
  MAX_MCP_TRANSPORT_BYTES,
  type CallToolResultLike,
  type McpClient,
  type McpToolLike,
} from "./client";
import { toMcpToolRegistryName } from "./naming";

const mcpToolInputSchema = z.object({}).catchall(z.unknown());
const EMPTY_MCP_RESULT = "MCP tool returned no content.";
export const MAX_MCP_SERIALIZED_RESULT_BYTES = MAX_MCP_TRANSPORT_BYTES;

// ─── Adapter ─────────────────────────────────────────────────────────────────

export function adaptMcpTool(
  mcpTool: McpToolLike,
  serverName: string,
  mcpClient: McpClient,
  redactionPolicy: SecretRedactionPolicy,
  logger?: Logger,
): AnyToolDescriptor {
  const toolName = mcpTool.name;
  const execLogger = logger ?? silentLogger;

  const traits = traitsFromAnnotations(mcpTool.annotations);

  return defineTool({
    name: toMcpToolRegistryName(serverName, toolName),
    description: mcpTool.description ?? fallbackDescription(serverName, toolName),
    inputSchema: mcpToolInputSchema,
    aiInputSchema: jsonSchema(mcpTool.inputSchema as Record<string, unknown>),
    traits,
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    ...(traits.destructive ? { permissions: [createMcpDestructivePermission(serverName, toolName)] } : {}),
    async execute(input): Promise<RawToolResult> {
      try {
        const result = await mcpClient.callTool(
          toolName,
          input as Record<string, unknown>,
        );
        const output = formatMcpResult(result);

        if (result.isError === true) {
          return createMcpErrorResult(serverName, toolName, output, redactionPolicy);
        }

        return createTextToolResult(output);
      } catch (err) {
        execLogger.warn("mcp.tool.execute.failed", {
          context: { serverName, toolName: mcpTool.name },
          error: logError(err, redactionPolicy),
        });
        return createMcpErrorResult(
          serverName,
          toolName,
          errorMessage(err),
          redactionPolicy,
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
  const writer = new BoundedUtf8Writer(MAX_MCP_SERIALIZED_RESULT_BYTES);
  let wroteContent = false;
  for (const block of result.content) {
    if (wroteContent) writer.append("\n");
    writeContentBlock(writer, block);
    wroteContent = true;
  }

  if (result.structuredContent !== undefined) {
    if (wroteContent) writer.append("\n");
    writer.append("Structured content:\n");
    writeJsonValue(writer, result.structuredContent, new Set(), 0);
  }

  const output = writer.finish().trim();
  return output.length > 0 ? output : EMPTY_MCP_RESULT;
}

function writeContentBlock(
  writer: BoundedUtf8Writer,
  block: CallToolResultLike["content"][number],
): void {
  if (block.type === "text") {
    if (typeof block.text === "string") writer.append(block.text);
    return;
  }

  if (typeof block.type !== "string") {
    throw new Error("MCP content block type must be a string");
  }
  writer.append("[Unsupported MCP content type: ");
  writer.append(block.type);
  writer.append("]");
}

function writeJsonValue(
  writer: BoundedUtf8Writer,
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): boolean {
  if (depth > 64) throw new Error("MCP structured content exceeds the nesting limit");
  if (value === null) {
    writer.append("null");
    return true;
  }
  switch (typeof value) {
    case "string":
      writer.appendJsonString(value);
      return true;
    case "boolean":
      writer.append(value ? "true" : "false");
      return true;
    case "number":
      writer.append(Number.isFinite(value) ? `${value}` : "null");
      return true;
    case "undefined":
    case "function":
    case "symbol":
      return false;
    case "bigint":
      throw new Error("MCP structured content is not JSON serializable");
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    throw new Error("MCP structured content is not JSON serializable");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      writer.append("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) writer.append(",");
        if (!writeJsonValue(writer, value[index], ancestors, depth + 1)) {
          writer.append("null");
        }
      }
      writer.append("]");
      return true;
    }

    writer.append("{");
    let wroteProperty = false;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const property = (value as Record<string, unknown>)[key];
      if (property === undefined || typeof property === "function" || typeof property === "symbol") {
        continue;
      }
      if (wroteProperty) writer.append(",");
      writer.appendJsonString(key);
      writer.append(":");
      writeJsonValue(writer, property, ancestors, depth + 1);
      wroteProperty = true;
    }
    writer.append("}");
    return true;
  } finally {
    ancestors.delete(value);
  }
}

class BoundedUtf8Writer {
  readonly #encoder = new TextEncoder();
  #buffer = new Uint8Array(4 * 1024);
  #length = 0;

  constructor(readonly maxBytes: number) {}

  append(value: string): void {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > this.maxBytes - this.#length) {
      throw new Error("MCP tool result exceeded the 8 MiB serialization limit");
    }
    this.#ensureCapacity(this.#length + bytes);
    const encoded = this.#encoder.encodeInto(value, this.#buffer.subarray(this.#length));
    if (encoded.read !== value.length || encoded.written !== bytes) {
      throw new Error("MCP tool result serialization failed");
    }
    this.#length += encoded.written;
  }

  appendJsonString(value: string): void {
    this.append('"');
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      let escaped: string | undefined;
      switch (code) {
        case 0x08: escaped = "\\b"; break;
        case 0x09: escaped = "\\t"; break;
        case 0x0a: escaped = "\\n"; break;
        case 0x0c: escaped = "\\f"; break;
        case 0x0d: escaped = "\\r"; break;
        case 0x22: escaped = '\\"'; break;
        case 0x5c: escaped = "\\\\"; break;
        default:
          if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff && !isSurrogatePairAt(value, index))) {
            escaped = `\\u${code.toString(16).padStart(4, "0")}`;
          } else if (code >= 0xd800 && code <= 0xdbff) {
            index += 1;
          }
      }
      if (escaped === undefined) continue;
      if (start < index) this.append(value.slice(start, index));
      this.append(escaped);
      start = index + 1;
    }
    if (start < value.length) this.append(value.slice(start));
    this.append('"');
  }

  finish(): string {
    return new TextDecoder().decode(this.#buffer.subarray(0, this.#length));
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#buffer.byteLength) return;
    let capacity = this.#buffer.byteLength;
    while (capacity < required) capacity = Math.min(this.maxBytes, Math.max(required, capacity * 2));
    const grown = new Uint8Array(capacity);
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
  }
}

function isSurrogatePairAt(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff;
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = value.charCodeAt(index - 1);
    return previous >= 0xd800 && previous <= 0xdbff;
  }
  return false;
}

function createMcpErrorResult(
  serverName: string,
  toolName: string,
  message: string,
  redactionPolicy: SecretRedactionPolicy,
): RawToolResult {
  const redactedMessage = redactionPolicy.redactString(message);
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

function logError(error: unknown, policy: SecretRedactionPolicy): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: policy.redactString(error.message) };
  }

  return { name: typeof error, message: "MCP tool execution failed" };
}

function fallbackDescription(serverName: string, toolName: string): string {
  return `MCP tool "${toolName}" from server "${serverName}".`;
}
