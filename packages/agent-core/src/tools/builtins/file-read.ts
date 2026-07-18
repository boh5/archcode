import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { getSystemErrorCode } from "../../utils";
import { createSourceToolResult } from "../results";
import type { RawToolResult } from "../types";
import { createSensitiveFilePermission, createWorkspacePermission } from "../permission";
import { createReadSnapshotAfterHook } from "../hooks";
import { resolveAndValidatePath } from "../security";
import { createLineSourcePage } from "./source-page";

// ─── Constants ───

const BINARY_DETECTION_BYTES = 8 * 1024;
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
      if (containsNullByte(buffer.subarray(0, Math.min(buffer.length, BINARY_DETECTION_BYTES)))) {
        return createSourceToolResult("Binary file, cannot display");
      }

      const startLine = input.offset ?? 1;
      const decoded = new TextDecoder().decode(buffer);
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
