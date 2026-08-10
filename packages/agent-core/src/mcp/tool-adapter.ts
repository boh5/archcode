import { jsonSchema } from "ai";
import { z } from "zod";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import type { SecretRedactionPolicy } from "../security";
import { defineTool } from "../tools/define-tool";
import { createToolErrorResult } from "../tools/errors";
import { createTextToolResult } from "../tools/results";
import type { RawToolResult, ToolDescriptor, ToolTraits } from "../tools/types";
import {
  MAX_MCP_TRANSPORT_BYTES,
  McpClient,
  type CallToolResultLike,
  type McpToolLike,
} from "./client";
import { McpToolExecutionError } from "./errors";
import { toMcpToolRegistryName } from "./naming";

// The remote MCP server owns the detailed JSON Schema. Locally we enforce only
// the object boundary so arbitrary valid server-defined arguments pass through unchanged.
const mcpToolInputSchema = z.object({}).catchall(z.unknown());
const EMPTY_MCP_RESULT = "MCP tool returned no content.";
export const MAX_MCP_SERIALIZED_RESULT_BYTES = MAX_MCP_TRANSPORT_BYTES;

export interface McpCallLease {
  readonly client: McpClient;
  release(): void;
}

export interface McpCallHandle {
  tryAcquireCall(): McpCallLease | undefined;
}

export interface McpToolBinding {
  /** Private protocol identity used only for dispatch and alias hashing. */
  readonly rawName: string;
  /** Presentation-safe alias exposed to the model and retained for execution lookup. */
  readonly registryName: string;
}

export function adaptMcpTool(
  mcpTool: McpToolLike,
  serverName: string,
  handle: McpCallHandle,
  redactionPolicy: SecretRedactionPolicy,
  logger: Logger = silentLogger,
  binding?: McpToolBinding,
): ToolDescriptor<z.infer<typeof mcpToolInputSchema>, RawToolResult> {
  const toolName = mcpTool.name;
  const rawToolName = binding?.rawName ?? toolName;
  const traits = traitsFromAnnotations(mcpTool.annotations);

  return defineTool({
    name: binding?.registryName ?? toMcpToolRegistryName(serverName, rawToolName, toolName),
    description: mcpTool.description ?? fallbackDescription(serverName, toolName),
    inputSchema: mcpToolInputSchema,
    aiInputSchema: jsonSchema((mcpTool.inputSchema ?? { type: "object" }) as Record<string, unknown>),
    traits,
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    async execute(input, context): Promise<RawToolResult> {
      if (context.abort.aborted) {
        return createMcpErrorResult(serverName, toolName, "MCP tool call was aborted before dispatch", "TOOL_MCP_CALL_ABORTED");
      }

      const lease = handle.tryAcquireCall();
      if (!lease) {
        return createMcpErrorResult(
          serverName,
          toolName,
          "The MCP server connection was retired before this call started",
          "TOOL_MCP_NOT_AVAILABLE",
        );
      }

      let attempted = false;
      try {
        if (context.abort.aborted) {
          return createMcpErrorResult(serverName, toolName, "MCP tool call was aborted before dispatch", "TOOL_MCP_CALL_ABORTED");
        }
        const result = await lease.client.callTool(
          rawToolName,
          input as Record<string, unknown>,
          context.abort,
          () => { attempted = true; },
        );
        const output = redactionPolicy.redactString(formatMcpResult(result));
        if (result.isError === true) {
          return createMcpErrorResult(serverName, toolName, output, "TOOL_MCP_ERROR");
        }
        return createTextToolResult(output);
      } catch (error) {
        logger.warn("mcp.tool.execute.failed", {
          context: { serverName, toolName },
          error: logError(error, redactionPolicy),
        });
        const reason = error instanceof McpToolExecutionError ? error.reason : "failed";
        const code = reason === "aborted"
          ? "TOOL_MCP_CALL_ABORTED"
          : reason === "timeout"
            ? "TOOL_MCP_CALL_TIMEOUT"
            : "TOOL_MCP_ERROR";
        const unknownResult = attempted && !traits.readOnly;
        return createMcpErrorResult(
          serverName,
          toolName,
          redactionPolicy.redactString(errorMessage(error)),
          code,
          unknownResult,
        );
      } finally {
        lease.release();
      }
    },
  });
}

/** MCP annotation defaults are conservative: only explicit read-only is parallel-safe. */
export function traitsFromAnnotations(annotations: McpToolLike["annotations"]): ToolTraits {
  const readOnly = annotations?.readOnlyHint === true;
  return {
    readOnly,
    destructive: !readOnly && annotations?.destructiveHint !== false,
    concurrencySafe: readOnly,
  };
}

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

function writeContentBlock(writer: BoundedUtf8Writer, block: CallToolResultLike["content"][number]): void {
  if (block.type === "text") {
    if (typeof block.text === "string") writer.append(block.text);
    return;
  }
  if (typeof block.type !== "string") throw new Error("MCP content block type must be a string");
  writer.append(`[Unsupported MCP content type: ${block.type}]`);
}

function writeJsonValue(writer: BoundedUtf8Writer, value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (depth > 64) throw new Error("MCP structured content exceeds the nesting limit");
  if (value === null) {
    writer.append("null");
    return true;
  }
  switch (typeof value) {
    case "string": writer.appendJsonString(value); return true;
    case "boolean": writer.append(value ? "true" : "false"); return true;
    case "number": writer.append(Number.isFinite(value) ? `${value}` : "null"); return true;
    case "undefined":
    case "function":
    case "symbol": return false;
    case "bigint": throw new Error("MCP structured content is not JSON serializable");
    case "object": break;
  }
  if (ancestors.has(value)) throw new Error("MCP structured content is not JSON serializable");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      writer.append("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) writer.append(",");
        if (!writeJsonValue(writer, value[index], ancestors, depth + 1)) writer.append("null");
      }
      writer.append("]");
      return true;
    }
    writer.append("{");
    let wroteProperty = false;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const property = (value as Record<string, unknown>)[key];
      if (property === undefined || typeof property === "function" || typeof property === "symbol") continue;
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
    if (bytes > this.maxBytes - this.#length) throw new Error("MCP tool result exceeded the 8 MiB serialization limit");
    this.#ensureCapacity(this.#length + bytes);
    const encoded = this.#encoder.encodeInto(value, this.#buffer.subarray(this.#length));
    if (encoded.read !== value.length || encoded.written !== bytes) throw new Error("MCP tool result serialization failed");
    this.#length += encoded.written;
  }

  appendJsonString(value: string): void {
    this.append(JSON.stringify(value));
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

function createMcpErrorResult(
  serverName: string,
  toolName: string,
  message: string,
  code: string,
  unknownResult = false,
): RawToolResult {
  const result = createToolErrorResult({
    kind: code === "TOOL_MCP_CALL_ABORTED" ? "cancelled" : "execution",
    code,
    name: "McpToolError",
    message: `MCP tool error from server "${serverName}", tool "${toolName}": ${message}`,
    hint: unknownResult
      ? "The external effect may have occurred. Inspect the external system before deciding whether to retry."
      : "Inspect the MCP status or tool error, then retry only if the call is still necessary.",
  });
  return unknownResult
    ? { ...result, details: { ...result.details, unknownResult: true } }
    : result;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown MCP tool error";
}

function logError(error: unknown, policy: SecretRedactionPolicy): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name || "Error", message: policy.redactString(error.message) }
    : { name: typeof error, message: policy.redactString(String(error)) };
}

function fallbackDescription(serverName: string, toolName: string): string {
  return `MCP tool "${toolName}" from server "${serverName}".`;
}
