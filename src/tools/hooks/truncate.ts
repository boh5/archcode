import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AfterHook, ToolExecutionContext, ToolExecutionResult } from "../types";

export interface TruncatorOptions {
  outputDir?: string;
  maxBytes?: number;
  maxLines?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;
const PREVIEW_LINES = 5;

function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function generateSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createOutputTruncator(options?: TruncatorOptions): AfterHook {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const outputDir = options?.outputDir ?? join(homedir(), ".specra", "tool-output");

  return async function truncationAfterHook(
    result: ToolExecutionResult,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult | void> {
    const byteCount = Buffer.byteLength(result.output, "utf-8");
    const lineCount = result.output.split("\n").length;

    const exceedsBytes = byteCount > maxBytes;
    const exceedsLines = lineCount > maxLines;

    if (!exceedsBytes && !exceedsLines) {
      return;
    }

    await mkdir(outputDir, { recursive: true });

    const sanitizedTool = sanitizeSegment(ctx.toolName);
    const sanitizedCallId = sanitizeSegment(ctx.toolCallId);
    const suffix = generateSuffix();
    const filename = `${sanitizedTool}-${sanitizedCallId}-${suffix}.txt`;
    const filePath = join(outputDir, filename);

    await writeFile(filePath, result.output, "utf-8");

    const lines = result.output.split("\n");
    const previewLines = lines.slice(0, PREVIEW_LINES).join("\n");
    const marker = `[Output truncated; full output saved to: ${filePath}]`;
    const shortened = `${previewLines}\n${marker}`;

    return {
      output: shortened,
      isError: result.isError,
      meta: {
        ...result.meta,
        truncated: true,
        fullOutputPath: filePath,
      },
    };
  };
}
