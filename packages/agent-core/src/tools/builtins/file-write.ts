import { existsSync } from "node:fs";
import { z } from "zod";
import { atomicWrite } from "../../utils/safe-file";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { computeToolDiff } from "../diff";
import { createToolErrorResult } from "../errors";
import { createFileExistsPermission, createProtectedPathPermission, createSensitiveFilePermission, createWorkspacePermission } from "../permission";
import { createPostEditDiagnosticsHook, refreshReadSnapshot } from "../hooks";
import { resolveAndValidatePath } from "../security";
import type { ToolExecutionResult } from "../types";

// ─── Input Schema ───

const FileWriteInputSchema = z
  .object({
    path: z.string().describe("Absolute or current-Session-cwd-relative path for the new file, for example `src/new-module.ts`. Missing parent directories are created automatically."),
    content: z.string().describe("Complete text content for the new file. Do not use placeholders, ellipses, or omit required sections."),
  })
  .strict();

// ─── Tool Definition ───

export const fileWriteTool = defineTool({
  name: "file_write",
  description: [
    "Create one new text file and any missing parent directories. Use it only when the requested file does not exist; prefer file_edit for every existing file.",
    "",
    "Provide the complete final content in one call, without placeholders or omitted sections. Example: `file_write({\"path\":\"src/new-module.ts\",\"content\":\"export const enabled = true;\\n\"})`. The call fails rather than overwriting an existing path; after that error, read the existing file and use file_edit instead.",
  ].join("\n"),
  inputSchema: FileWriteInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  permissions: [createWorkspacePermission(), createFileExistsPermission(), createSensitiveFilePermission(), createProtectedPathPermission()],
  hooks: { after: [createPostEditDiagnosticsHook()] },
  execute: async (input, ctx): Promise<string | ToolExecutionResult> => {
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
        return {
          output: `File written to ${input.path}`,
          isError: false,
          meta: {
            diffs: computeToolDiff({
              path: input.path,
              before: "",
              after: input.content,
              status: "created",
            }),
          },
        };
      });
    } catch (error) {
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
