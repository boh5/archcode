import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompletedToolPart, ErrorToolPart } from "../store/types";

export const TOOL_OUTPUT_DIR = join(homedir(), ".specra", "tool-output");

const DEFAULT_PREVIEW_LINES = 5;

export interface PersistOptions {
  previewLines?: number;
  force?: boolean;
  outputDir?: string;
}

export type PersistableToolPart = CompletedToolPart | ErrorToolPart;

function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildFilePath(
  toolName: string,
  callId: string,
  sessionId: string,
  baseDir: string,
): string {
  const sanitizedTool = sanitizeSegment(toolName);
  const sanitizedCallId = sanitizeSegment(callId);
  const sanitizedSession = sanitizeSegment(sessionId);
  const filename = `${sanitizedTool}-${sanitizedCallId}-full.txt`;
  return join(baseDir, sanitizedSession, filename);
}

function buildUpdatedOutput(
  rawOutput: string,
  fullPath: string,
  previewLines: number,
): string {
  const marker = `[Output truncated; full output saved to: ${fullPath}]`;
  if (previewLines <= 0) {
    return marker;
  }
  const lines = rawOutput.split("\n");
  const preview = lines.slice(0, previewLines).join("\n");
  return `${preview}\n${marker}`;
}

export async function persistToolOutputValue(
  rawOutput: string,
  toolName: string,
  callId: string,
  sessionId: string,
  options?: PersistOptions,
): Promise<{ fullPath: string; updatedOutput: string }> {
  const baseDir = options?.outputDir ?? TOOL_OUTPUT_DIR;
  const previewLines = options?.previewLines ?? DEFAULT_PREVIEW_LINES;
  const filePath = buildFilePath(toolName, callId, sessionId, baseDir);

  try {
    await mkdir(join(baseDir, sanitizeSegment(sessionId)), { recursive: true });
    await Bun.write(filePath, rawOutput);
  } catch (error) {
    console.error(
      `[persistToolOutputValue] Failed to write output to ${filePath}:`,
      error instanceof Error ? error.message : error,
    );
    return { fullPath: "", updatedOutput: rawOutput };
  }

  const updatedOutput = buildUpdatedOutput(rawOutput, filePath, previewLines);
  return { fullPath: filePath, updatedOutput };
}

export async function persistToolOutput(
  toolPart: PersistableToolPart,
  sessionId: string,
  options?: PersistOptions,
): Promise<string> {
  if (toolPart.meta?.fullOutputPath && !options?.force) {
    return toolPart.meta.fullOutputPath as string;
  }

  const rawOutput =
    toolPart.state === "completed" ? toolPart.output : toolPart.errorMessage;
  const toolName = toolPart.toolName;
  const callId = toolPart.toolCallId;

  const result = await persistToolOutputValue(
    rawOutput,
    toolName,
    callId,
    sessionId,
    options,
  );

  if (!result.fullPath) {
    return "";
  }

  if (!toolPart.meta) {
    toolPart.meta = {};
  }
  toolPart.meta.fullOutputPath = result.fullPath;

  if (toolPart.state === "completed") {
    toolPart.output = result.updatedOutput;
  } else {
    toolPart.errorMessage = result.updatedOutput;
  }

  return result.fullPath;
}