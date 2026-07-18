import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { getSystemErrorCode } from "../../utils";
import type { ToolExecutionResult } from "../types";
import { createSensitiveFilePermission, createWorkspacePermission } from "../permission";
import { createReadSnapshotAfterHook } from "../hooks";
import { resolveAndValidatePath } from "../security";

// ─── Constants ───

const BINARY_DETECTION_BYTES = 8 * 1024;
const MAX_READ_BYTES = 50 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// ─── Input Schema ───

const FileReadInputSchema = z
  .object({
    path: z.string().describe("Absolute or workspace-relative text-file path, for example `packages/agent-core/src/runtime.ts`. Relative paths resolve from the current Session cwd; reading outside the workspace may require approval."),
    offset: z.number().int().positive().optional().describe("1-based line number to start reading from, for example 120. Defaults to 1 and is applied before the 50KB source window."),
    limit: z.number().int().positive().optional().describe("Maximum number of lines to return from offset, for example 160. The 50KB source window may return fewer lines."),
  })
  .strict();

type FileReadInput = z.infer<typeof FileReadInputSchema>;

// ─── Formatting ───

function containsNullByte(buffer: Uint8Array): boolean {
  return buffer.includes(0);
}

function createFileTooLargeResult(size: number): ToolExecutionResult {
  return createToolErrorResult({
    kind: "file-too-large",
    code: "TOOL_FILE_TOO_LARGE",
    message: `File is too large to display (${(size / 1024 / 1024).toFixed(1)} MB). The hard file-size limit is 10 MB.`,
    hint: "Use a search or shell tool designed for large files; file_read cannot read this file.",
  });
}

function findLineStart(buffer: Uint8Array, lineNumber: number): number {
  if (lineNumber === 1) return 0;

  let currentLine = 1;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    currentLine += 1;
    if (currentLine === lineNumber) return index + 1;
  }

  return buffer.length;
}

function findLineRangeEnd(
  buffer: Uint8Array,
  startByte: number,
  limit: number | undefined,
): number {
  if (limit === undefined) return buffer.length;

  let remainingLines = limit;
  for (let index = startByte; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    remainingLines -= 1;
    if (remainingLines === 0) return index + 1;
  }

  return buffer.length;
}

function clampToUtf8Boundary(
  buffer: Uint8Array,
  startByte: number,
  endByte: number,
): number {
  if (endByte >= buffer.length || (buffer[endByte] & 0xc0) !== 0x80) {
    return endByte;
  }

  let leadingByte = endByte - 1;
  while (leadingByte > startByte && (buffer[leadingByte] & 0xc0) === 0x80) {
    leadingByte -= 1;
  }

  return leadingByte;
}

function formatLines(content: string, startLine: number): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines
    .map((line, index) => `${startLine + index}: ${line}\n`)
    .join("");
}

// ─── Tool Definition ───

export const fileReadTool = defineTool({
  name: "file_read",
  description: [
    "Read a UTF-8 text file and return `N: content` line-numbered output.",
    "",
    "Use it when the file path is known. If the path is unknown, find it with glob; if the relevant lines are unknown, locate them with grep; then read a bounded range. Example workflow: `glob({\"pattern\":\"**/*.ts\"})` -> `grep({\"pattern\":\"createRuntime\",\"include\":\"*.ts\"})` -> `file_read({\"path\":\"packages/agent-core/src/runtime.ts\",\"offset\":120,\"limit\":160})`. When several known files are independent, issue their file_read calls together.",
    "",
    "offset is 1-based. The selected offset/limit range is chosen before the 50KB source window. Avoid tiny repeated slices when one larger bounded range would provide the needed context. Files larger than 10MB are rejected, and binary files are not displayed. If a selected range exceeds 50KB, the result is truncated with a notice; because offset is line-based, it cannot continue within a single line longer than 50KB. Relative paths resolve from the current Session cwd, and paths outside the workspace may require approval.",
  ].join("\n"),
  inputSchema: FileReadInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  permissions: [createWorkspacePermission(), createSensitiveFilePermission()],
  hooks: { after: [createReadSnapshotAfterHook()] },
  execute: async (input, ctx): Promise<string | ToolExecutionResult> => {
    // Workspace access is enforced by createWorkspacePermission() guard.
    // If the permission pipeline allows execution, out-of-workspace paths
    // may have been explicitly approved and should not be re-checked here.
    const { resolved } = resolveAndValidatePath(
      input.path,
      ctx.cwd,
    );

    try {
      const file = Bun.file(resolved);
      const size = file.size;
      if (size > MAX_FILE_BYTES) {
        return createFileTooLargeResult(size);
      }

      const buffer = await file.bytes();
      if (buffer.length > MAX_FILE_BYTES) {
        return createFileTooLargeResult(buffer.length);
      }
      if (containsNullByte(buffer.subarray(0, Math.min(buffer.length, BINARY_DETECTION_BYTES)))) {
        return "Binary file, cannot display";
      }

      const startLine = input.offset ?? 1;
      const startByte = findLineStart(buffer, startLine);
      const requestedEndByte = findLineRangeEnd(buffer, startByte, input.limit);
      const rawEndByte = Math.min(requestedEndByte, startByte + MAX_READ_BYTES);
      const endByte = rawEndByte < requestedEndByte
        ? clampToUtf8Boundary(buffer, startByte, rawEndByte)
        : rawEndByte;
      const contentBuffer = buffer.subarray(startByte, endByte);
      const content = new TextDecoder().decode(contentBuffer);
      const formatted = formatLines(content, startLine);

      if (endByte < requestedEndByte) {
        return formatted +
          `\n[Output truncated: the selected line range exceeds the ${MAX_READ_BYTES}-byte source window. ` +
          "Use a later offset for following lines; a single line longer than the window cannot be continued with line-based offset.]";
      }

      return formatted;
    } catch (error) {
      const code = getSystemErrorCode(error);
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
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
