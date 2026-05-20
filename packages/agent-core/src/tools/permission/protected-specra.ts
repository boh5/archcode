import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PermissionDecision, ToolPermission, ToolExecutionContext } from "../types";
import type { ToolErrorKind } from "../errors";

const SPECRA_SUFFIX = join(".specra");

/**
 * Resolve a file path to its real path, handling symlinks and traversing
 * upwards from parent directories when intermediate paths don't exist yet.
 */
function resolveRealPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    const parent = resolve(filePath, "..");
    if (parent === filePath) return filePath;
    return join(resolveRealPath(parent), filePath.slice(filePath.lastIndexOf(sep) + 1));
  }
}

/**
 * Creates a permission guard that denies direct mutation of any file or
 * directory under `workspaceRoot/.specra/**`. This protects the entire
 * `.specra/` directory tree from being modified by ordinary file mutation
 * tools (file_write, file_edit), ensuring only internal managers (memory
 * manager, project approval manager) may mutate these paths via direct
 * filesystem APIs.
 *
 * The guard performs symlink-safe realpath resolution to prevent traversal
 * attacks.
 */
export function createProtectedSpecraPermission(): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    const data = input as { path?: string };
    if (!data.path) {
      return { outcome: "allow" };
    }

    const inputAbsolute = resolve(ctx.workspaceRoot, data.path);
    const resolvedInput = resolveRealPath(inputAbsolute);

    const specraDir = resolve(ctx.workspaceRoot, SPECRA_SUFFIX);
    const resolvedSpecra = resolveRealPath(specraDir);

    // Check if the resolved path is under the resolved .specra directory
    const isUnderSpecra = resolvedInput.startsWith(resolvedSpecra + sep) || resolvedInput === resolvedSpecra;

    if (isUnderSpecra) {
      return {
        outcome: "deny",
        reason:
          "The .specra/ directory is system-managed and cannot be edited directly. " +
          "Use the appropriate internal tools (e.g., memory_write) to modify files in this directory.",
        errorKind: "permission-denied" as ToolErrorKind,
        errorCode: "SPECRA_PROTECTED_PATH_WRITE_DENIED",
      };
    }

    return { outcome: "allow" };
  };
}
