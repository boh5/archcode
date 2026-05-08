import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionResult } from "../types";
import {
  createReadSnapshotAfterHook,
  createSensitiveFileGuard,
  createWorkspaceGuard,
  resolveAndValidatePath,
} from "../hooks/read-snapshot";

// ─── Constants ───

const BINARY_DETECTION_BYTES = 8 * 1024;
const MAX_READ_BYTES = 50 * 1024;

// ─── Input Schema ───

const FileReadInputSchema = z
  .object({
    path: z.string(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

type FileReadInput = z.infer<typeof FileReadInputSchema>;

// ─── Formatting ───

function containsNullByte(buffer: Uint8Array): boolean {
  return buffer.includes(0);
}

function formatLines(content: string, input: FileReadInput): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const startLine = input.offset ?? 1;
  const startIndex = startLine - 1;
  const endIndex = input.limit === undefined ? undefined : startIndex + input.limit;

  return lines
    .slice(startIndex, endIndex)
    .map((line, index) => `${startLine + index}: ${line}\n`)
    .join("");
}

// ─── Tool Definition ───

export const fileReadTool = defineTool({
  name: "file_read",
  description:
    "Reads a file from the filesystem and returns line-numbered text. Paths are resolved relative to the workspace root.",
  inputSchema: FileReadInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  guards: [createWorkspaceGuard(), createSensitiveFileGuard()],
  hooks: { after: [createReadSnapshotAfterHook()] },
  execute: async (input, ctx): Promise<string | ToolExecutionResult> => {
    const { resolved, isWithinWorkspace } = resolveAndValidatePath(
      input.path,
      ctx.workspaceRoot,
    );

    if (!isWithinWorkspace) {
      return createToolErrorResult({
        kind: "workspace",
        code: "TOOL_FILE_OUTSIDE_WORKSPACE",
        message: `Path "${input.path}" is outside the workspace`,
      });
    }

    try {
      const fileStat = await stat(resolved);
      const size = fileStat.size;
      if (size > 10 * 1024 * 1024) {
        return createToolErrorResult({
          kind: "file-too-large",
          code: "TOOL_FILE_TOO_LARGE",
          message: `File is too large to display (${(size / 1024 / 1024).toFixed(1)} MB). Use offset and limit to read in chunks.`,
        });
      }

      const buffer = await readFile(resolved);
      if (containsNullByte(buffer.subarray(0, Math.min(buffer.length, BINARY_DETECTION_BYTES)))) {
        return "Binary file, cannot display";
      }

      const contentBuffer = buffer.subarray(0, MAX_READ_BYTES);
      const content = new TextDecoder().decode(contentBuffer);
      const formatted = formatLines(content, input);

      if (buffer.length > MAX_READ_BYTES) {
        return formatted + `\n[Output truncated: showing first ${MAX_READ_BYTES} bytes of ${buffer.length} total]`;
      }

      return formatted;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_FILE_NOT_FOUND",
            message: `File not found: ${input.path}`,
          });
        }
        if (code === "EACCES" || code === "EPERM") {
          return createToolErrorResult({
            kind: "file-permission-denied",
            code: "TOOL_FILE_PERMISSION_DENIED",
            message: `Permission denied: ${input.path}`,
          });
        }
      }
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
