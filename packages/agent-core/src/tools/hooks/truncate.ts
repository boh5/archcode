import type { AfterHook, ToolExecutionContext, ToolExecutionResult } from "../types";
import { persistToolOutputValue, TOOL_OUTPUT_DIR } from "../persist-output";

export interface TruncatorOptions {
  outputDir?: string;
  maxBytes?: number;
  maxLines?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;
const PREVIEW_LINES = 5;

export function createOutputTruncator(options?: TruncatorOptions): AfterHook {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const outputDir = options?.outputDir ?? TOOL_OUTPUT_DIR;

  return async function truncationAfterHook(
    result: ToolExecutionResult,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult | void> {
    const byteCount = new TextEncoder().encode(result.output).length;
    const lineCount = result.output.split("\n").length;

    const exceedsBytes = byteCount > maxBytes;
    const exceedsLines = lineCount > maxLines;

    if (!exceedsBytes && !exceedsLines) {
      return;
    }

    const sessionId = ctx.store.getState().sessionId;

    const persisted = await persistToolOutputValue(
      result.output,
      ctx.toolName,
      ctx.toolCallId,
      sessionId,
      { outputDir, previewLines: PREVIEW_LINES },
    );

    if (!persisted.fullPath) {
      return;
    }

    return {
      output: persisted.updatedOutput,
      isError: result.isError,
      meta: {
        ...result.meta,
        truncated: true,
        fullOutputPath: persisted.fullPath,
      },
    };
  };
}