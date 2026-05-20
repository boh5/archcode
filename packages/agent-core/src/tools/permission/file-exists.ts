import { existsSync } from "node:fs";
import type { PermissionDecision, ToolPermission, ToolExecutionContext } from "../types";
import { resolveAndValidatePath } from "../security";

export function createFileExistsPermission(): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    const inputRecord = input as { path: string };
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