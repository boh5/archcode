import { statSync } from "node:fs";
import type { PermissionDecision, ToolPermission, ToolExecutionContext } from "../types";
import { resolveAndValidatePath } from "../security";

export function createReadBeforeEditPermission(): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    const inputRecord = input as { path: string };
    const { resolved } = resolveAndValidatePath(
      inputRecord.path,
      ctx.workspaceRoot,
    );

    const snapshots = ctx.store.getState().readSnapshots;

    if (!snapshots.has(resolved)) {
      return {
        outcome: "deny",
        reason: `File "${resolved}" has not been read first. Use file_read before editing. [TOOL_FILE_NOT_READ_FIRST]`,
      };
    }

    let currentMtime: number;
    try {
      currentMtime = statSync(resolved).mtimeMs;
    } catch {
      return {
        outcome: "deny",
        reason: `File "${resolved}" no longer exists. [TOOL_FILE_NOT_FOUND]`,
      };
    }

    const recordedMtime = snapshots.get(resolved)!;

    if (currentMtime !== recordedMtime) {
      return {
        outcome: "deny",
        reason: `File "${resolved}" has been modified since it was read. Use file_read to refresh before editing. [TOOL_FILE_WRITE_CONFLICT]`,
      };
    }

    return { outcome: "allow" };
  };
}