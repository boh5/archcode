import { z } from "zod";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { TOOL_OUTPUT_DIR } from "../persist-output";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import type { CompletedToolPart, ErrorToolPart, ToolPart, StoredMessage } from "../../store/types";

// ─── Custom Error ───

export class ToolOutputNotFoundError extends Error {
  constructor(callId: string) {
    super(`Tool output has been evicted from cache (callId: ${callId})`);
    this.name = "ToolOutputNotFoundError";
  }
}

// ─── Input Schema ───

const ViewToolOutputInputSchema = z
  .object({
    callId: z.string().describe("The callId of the previous tool call to retrieve full output for"),
  })
  .strict();

type ViewToolOutputInput = z.infer<typeof ViewToolOutputInputSchema>;

// ─── Helpers ───

/** Canonical TOOL_OUTPUT_DIR with trailing separator for prefix matching. */
const CANONICAL_OUTPUT_DIR: string = (() => {
  const dir = realpathSync.native(resolve(TOOL_OUTPUT_DIR));
  return dir.endsWith("/") ? dir : dir + "/";
})();

function findToolPartByCallId(
  messages: readonly StoredMessage[],
  callId: string,
): ToolPart | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.toolCallId === callId) {
        return part;
      }
    }
  }
  return undefined;
}

function hasMetaField(
  part: ToolPart,
): part is (CompletedToolPart | ErrorToolPart) & { meta: Record<string, unknown> } {
  return (part.state === "completed" || part.state === "error") && part.meta !== undefined;
}

/**
 * Resolve and validate a tool output path.
 *
 * Security checks:
 * 1. Resolve `..` traversal via `resolve()`
 * 2. Verify resolved path starts with canonical TOOL_OUTPUT_DIR
 * 3. Resolve symlinks via `realpath()` and verify containment again
 */
async function resolveSafePath(
  fullOutputPath: string,
  callId: string,
): Promise<{ path: string } | { error: ToolExecutionResult }> {
  const resolved = resolve(fullOutputPath);

  // ── Check 1: Path containment ──
  if (!resolved.startsWith(CANONICAL_OUTPUT_DIR)) {
    return {
      error: createToolErrorResult({
        kind: "workspace",
        code: "TOOL_INVALID_OUTPUT_REFERENCE",
        message: "Invalid tool output reference",
      }),
    };
  }

  // ── Check 2: Resolve symlinks (defense in depth) ──
  try {
    const realPath = await realpath(resolved);
    if (!realPath.startsWith(CANONICAL_OUTPUT_DIR)) {
      return {
        error: createToolErrorResult({
          kind: "workspace",
          code: "TOOL_INVALID_OUTPUT_REFERENCE",
          message: "Invalid tool output reference",
        }),
      };
    }
    return { path: realPath };
  } catch {
    // realpath fails when file doesn't exist → check existence below
    const file = Bun.file(resolved);
    const exists = await file.exists();
    if (!exists) {
      return {
        error: createToolErrorResult({
          kind: "file-not-found",
          code: "TOOL_OUTPUT_NOT_FOUND",
          message: `Tool output has been evicted from cache (callId: ${callId})`,
        }),
      };
    }
    return { path: resolved };
  }
}

// ─── Execute Logic ───

export async function executeViewToolOutput(
  input: ViewToolOutputInput,
  ctx: ToolExecutionContext,
): Promise<string | ToolExecutionResult> {
  const { messages } = ctx.store.getState();
  const toolPart = findToolPartByCallId(messages, input.callId);

  if (!toolPart) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_CALL_NOT_FOUND",
      message: `Tool call not found: ${input.callId}`,
    });
  }

  // ── Persisted output on disk (fullOutputPath in meta) ──
  if (hasMetaField(toolPart) && toolPart.meta.fullOutputPath) {
    const fullOutputPath = String(toolPart.meta.fullOutputPath);
    const result = await resolveSafePath(fullOutputPath, input.callId);

    if ("error" in result) {
      return result.error;
    }

    const file = Bun.file(result.path);
    return await file.text();
  }

  // ── In-memory output (no fullOutputPath) ──
  if (toolPart.state === "completed") {
    return toolPart.output;
  }
  if (toolPart.state === "error") {
    return toolPart.errorMessage;
  }

  // ── Pending or running ──
  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_CALL_NOT_COMPLETED",
    message: `Tool call ${input.callId} has not completed yet (state: ${toolPart.state})`,
  });
}

// ─── Tool Definition ───

export const viewToolOutputTool = defineTool({
  name: "view_tool_output",
  description:
    "Retrieves the full output of a previous tool call by its callId. " +
    "Useful when a previous tool call's output was truncated and the full output was persisted to disk. " +
    "Provide the callId from the tool call you want to inspect.",
  inputSchema: ViewToolOutputInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  execute: executeViewToolOutput,
});
