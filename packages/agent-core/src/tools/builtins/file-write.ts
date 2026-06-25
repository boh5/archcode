import { existsSync } from "node:fs";
import { z } from "zod";
import { atomicWrite } from "../../utils/safe-file";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { computeToolDiff } from "../diff";
import { createToolErrorResult } from "../errors";
import { createFileExistsPermission, createProtectedPathPermission, createSensitiveFilePermission, createWorkspacePermission } from "../permission";
import { refreshReadSnapshot } from "../hooks";
import { resolveAndValidatePath } from "../security";
import type { ToolExecutionResult } from "../types";

// ─── Input Schema ───

const FileWriteInputSchema = z
  .object({
    path: z.string().describe("Absolute or workspace-relative path where the new file will be created"),
    content: z.string().describe("Full text content to write to the file"),
  })
  .strict();

// ─── Tool Definition ───

export const fileWriteTool = defineTool({
  name: "file_write",
  description:
    "Creates a new file at the specified path. Fails if the file already exists. Use file_edit to modify existing files.",
  inputSchema: FileWriteInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  permissions: [createWorkspacePermission(), createFileExistsPermission(), createSensitiveFilePermission(), createProtectedPathPermission()],
  execute: async (input, ctx): Promise<string | ToolExecutionResult> => {
    // Workspace access is enforced by createWorkspacePermission() guard.
    // If the permission pipeline allows execution, out-of-workspace paths
    // may have been explicitly approved and should not be re-checked here.
    const { resolved: resolvedPath } = resolveAndValidatePath(input.path, ctx.workspaceRoot);

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

        refreshReadSnapshot(resolvedPath, ctx.store, ctx.workspaceRoot);
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
