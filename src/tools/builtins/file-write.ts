import { existsSync } from "node:fs";
import { z } from "zod";
import { atomicWrite } from "../../utils/safe-file";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createFileExistsPermission, createProtectedSpecraPermission, createSensitiveFilePermission, createWorkspacePermission } from "../permission";
import { refreshReadSnapshot } from "../hooks";
import { resolveAndValidatePath } from "../security";
import type { ToolExecutionResult } from "../types";

// ─── Input Schema ───

const FileWriteInputSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .strict();

// ─── Tool Definition ───

export const fileWriteTool = defineTool({
  name: "file_write",
  description:
    "Creates a new file at the specified path. Fails if the file already exists. Use file_edit to modify existing files.",
  inputSchema: FileWriteInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  permissions: [createWorkspacePermission(), createFileExistsPermission(), createSensitiveFilePermission(), createProtectedSpecraPermission()],
  execute: async (input, ctx): Promise<string | ToolExecutionResult> => {
    const { resolved: resolvedPath, isWithinWorkspace } = resolveAndValidatePath(input.path, ctx.workspaceRoot);
    if (!isWithinWorkspace) {
      return createToolErrorResult({
        kind: "workspace",
        code: "TOOL_FILE_OUTSIDE_WORKSPACE",
        message: `"${resolvedPath}" is outside workspace "${ctx.workspaceRoot}"`,
      });
    }

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
        return `File written to ${input.path}`;
      });
    } catch (error) {
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
