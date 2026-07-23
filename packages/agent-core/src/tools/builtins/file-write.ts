import { existsSync } from "node:fs";
import { z } from "zod";
import { atomicWrite } from "../../utils/safe-file";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { computeToolDiff } from "../diff";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import { createFileExistsPermission, createProtectedPathPermission, createSensitiveFilePermission, createWorkspacePermission } from "../permission";
import { createPostEditDiagnosticsHook, refreshReadSnapshot } from "../hooks";
import { resolveAndValidatePath } from "../security";
import type { RawToolResult } from "../types";

// ─── Input Schema ───

const FileWriteInputSchema = z
  .object({
    path: z.string().describe("Absolute or current-Session-cwd-relative path for a genuinely new file, for example `src/new-module.ts`. The target path must not already exist; use file_edit for every existing file. Missing parent directories are created automatically."),
    content: z.string().describe("Complete text content for the new file. Do not use placeholders, ellipses, or omit required sections."),
  })
  .strict();

// ─── Tool Definition ───

export const fileWriteTool = defineTool({
  name: "file_write",
  description: [
    "CREATE NEW TEXT FILE ONLY. The target path MUST NOT already exist. Never use file_write to replace, rewrite, or update an existing file; every modification to an existing file MUST use file_edit.",
    "",
    "If you do not know whether the path exists, check with file_read or glob before calling file_write. Do not call file_write merely to probe existence.",
    "",
    "Create any missing parent directories and provide the complete final content in one call, without placeholders or omitted sections. Example: `file_write({\"path\":\"src/new-module.ts\",\"content\":\"export const enabled = true;\\n\"})`. The call always fails rather than overwriting an existing path.",
  ].join("\n"),
  inputSchema: FileWriteInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  permissions: [createWorkspacePermission(), createFileExistsPermission(), createSensitiveFilePermission(), createProtectedPathPermission()],
  hooks: { after: [createPostEditDiagnosticsHook()] },
  execute: async (input, ctx): Promise<RawToolResult> => {
    // Workspace access is enforced by createWorkspacePermission() guard.
    // If the permission pipeline allows execution, out-of-workspace paths
    // may have been explicitly approved and should not be re-checked here.
    const { resolved: resolvedPath } = resolveAndValidatePath(input.path, ctx.cwd);

    try {
      return await sharedMutationQueue.enqueue(resolvedPath, async () => {
        if (existsSync(resolvedPath)) {
          return createToolErrorResult({
            kind: "file-already-exists",
            code: "TOOL_FILE_ALREADY_EXISTS",
            message: `File "${resolvedPath}" already exists. Use file_edit to modify existing files.`,
          });
        }

        await atomicWrite(resolvedPath, input.content);

        refreshReadSnapshot(resolvedPath, ctx.store, ctx.cwd);
        const diff = computeToolDiff({
          path: input.path,
          before: "",
          after: input.content,
          status: "created",
        });
        return createTextToolResult(`File written to ${input.path}`, {
          details: diff.files.length === 0
            ? undefined
            : { presentations: [{ kind: "diff", files: diff.files, ...(diff.truncated ? { truncated: true } : {}) }] },
        });
      });
    } catch (error) {
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
