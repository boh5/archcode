import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createSensitiveFileGuard } from "../hooks/sensitive-file-guard";
import { createWorkspaceGuard } from "../hooks/workspace-guard";
import { refreshReadSnapshot } from "../hooks/read-snapshot";
import { resolveAndValidatePath } from "../security/path-validator";
import type { GuardDecision, GuardHook, ToolExecutionContext, ToolExecutionResult } from "../types";

// ─── Input Schema ───

const FileWriteInputSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .strict();

type FileWriteInput = z.infer<typeof FileWriteInputSchema>;

// ─── Guards ───

function createFileExistsGuard(): GuardHook {
  return (input: unknown, ctx: ToolExecutionContext): GuardDecision => {
    const inputRecord = input as FileWriteInput;
    const { resolved } = resolveAndValidatePath(inputRecord.path, ctx.workspaceRoot);

    if (existsSync(resolved)) {
      return {
        outcome: "deny",
        reason: `File "${resolved}" already exists. Use file_edit to modify existing files.`,
        errorKind: "file-already-exists",
        errorCode: "TOOL_FILE_ALREADY_EXISTS",
      };
    }

    return { outcome: "allow" };
  };
}

async function cleanupTempFile(tmpPath: string): Promise<void> {
  try {
    await Bun.file(tmpPath).delete();
  } catch {
    // best-effort
  }
}

// ─── Tool Definition ───

export const fileWriteTool = defineTool({
  name: "file_write",
  description:
    "Creates a new file at the specified path. Fails if the file already exists. Use file_edit to modify existing files.",
  inputSchema: FileWriteInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  guards: [createWorkspaceGuard(), createFileExistsGuard(), createSensitiveFileGuard()],
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

        const parentDir = path.dirname(resolvedPath);
        await mkdir(parentDir, { recursive: true });

        const tmpPath = `${resolvedPath}.tmp.${crypto.randomUUID()}`;
        await Bun.write(tmpPath, input.content);

        try {
          await rename(tmpPath, resolvedPath);
        } catch (error) {
          await cleanupTempFile(tmpPath);
          throw error;
        }

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
