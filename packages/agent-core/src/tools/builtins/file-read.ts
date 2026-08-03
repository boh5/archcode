import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { getSystemErrorCode } from "../../utils";
import type { RawToolResult } from "../types";
import { createSensitiveFilePermission, createWorkspacePermission } from "../permission";
import { createReadSnapshotAfterHook } from "../hooks";
import { resolveAndValidatePath } from "../security";
import { createLineSourcePage } from "./source-page";

// ─── Constants ───

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

function createFileTooLargeResult(size: number): RawToolResult {
  return createToolErrorResult({
    kind: "file-too-large",
    code: "TOOL_FILE_TOO_LARGE",
    message: `File is too large to display (${(size / 1024 / 1024).toFixed(1)} MB). The hard file-size limit is 10 MB.`,
    hint: "Use a search or shell tool designed for large files; file_read cannot read this file.",
  });
}

function createNonTextResult(message: string): RawToolResult {
  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_FILE_NOT_UTF8_TEXT",
    message,
    hint: "Use Bash with an installed CLI that supports this file format. Existing Bash permissions still apply; if no suitable parser is installed, report that limitation.",
  });
}

// ─── Tool Definition ───

export const fileReadTool = defineTool({
  name: "file_read",
  description: [
    "Read a strictly valid UTF-8 text file without NUL bytes and return `N: content` line-numbered output.",
    "",
    "Use it when the file path is known. If the path is unknown, find it with glob; if the relevant lines are unknown, locate them with grep; then read a bounded range. Example workflow: `glob({\"pattern\":\"**/*.ts\"})` -> `grep({\"pattern\":\"createRuntime\",\"include\":\"*.ts\"})` -> `file_read({\"path\":\"packages/agent-core/src/runtime.ts\",\"offset\":120,\"limit\":160})`. When several known files are independent, issue their file_read calls together.",
    "",
    "offset is 1-based. The selected offset/limit range is chosen before the 50KB source window. Avoid tiny repeated slices when one larger bounded range would provide the needed context. Files larger than 10MB, invalid UTF-8, and any file containing a NUL byte are rejected. Images, PDF, DOCX/XLSX/PPTX, ZIP, audio, video, and other binary or container formats are not decoded by file_read; use pdf_read for native PDF text, and Bash with an installed appropriate CLI for other supported formats. Existing Bash permissions still apply, and when no suitable parser is installed you must report that limitation rather than claiming generic support. If a selected range exceeds 50KB, the result is truncated with a notice; because offset is line-based, it cannot continue within a single line longer than 50KB. Relative paths resolve from the current Session cwd, and paths outside the workspace may require approval.",
  ].join("\n"),
  inputSchema: FileReadInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "source", previewDirection: "head" },
  permissions: [createWorkspacePermission(), createSensitiveFilePermission()],
  hooks: { after: [createReadSnapshotAfterHook()] },
  execute: async (input, ctx): Promise<RawToolResult> => {
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
      if (containsNullByte(buffer)) {
        return createNonTextResult("File contains a NUL byte and is not supported by file_read.");
      }

      const startLine = input.offset ?? 1;
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        return createNonTextResult("File is not valid UTF-8 text and is not supported by file_read.");
      }
      const fileLines = decoded.split("\n");
      if (fileLines.at(-1) === "") fileLines.pop();
      const available = fileLines.slice(startLine - 1, input.limit === undefined ? undefined : startLine - 1 + input.limit);
      const numbered = available.map((line, index) => `${startLine + index}: ${line}`);
      return createLineSourcePage({
        lines: numbered,
        offset: 0,
        emptyText: "",
        nextInput: (consumed) => ({
          path: input.path,
          offset: startLine + consumed,
          ...(input.limit === undefined ? {} : { limit: input.limit - consumed }),
        }),
      });
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
