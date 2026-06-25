import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PermissionDecision, ToolPermission, ToolExecutionContext } from "../types";
import type { ToolErrorKind } from "../errors";

const MEMORY_INDEX_SUFFIX = join(".archcode", "memory", "index.md");

function resolveRealPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    const parent = resolve(filePath, "..");
    if (parent === filePath) return filePath;
    return join(resolveRealPath(parent), filePath.slice(filePath.lastIndexOf(sep) + 1));
  }
}

export function createMemoryIndexPermission(): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    const data = input as { path?: string };
    if (!data.path) {
      return { outcome: "allow" };
    }

    const inputAbsolute = resolve(ctx.workspaceRoot, data.path);
    const resolvedInput = resolveRealPath(inputAbsolute);

    const expectedIndexPath = resolve(ctx.workspaceRoot, MEMORY_INDEX_SUFFIX);
    const resolvedExpected = resolveRealPath(expectedIndexPath);

    if (resolvedInput === resolvedExpected) {
      return {
        outcome: "deny",
        reason:
          "Memory index is system-managed and cannot be edited directly. " +
          "Use memory_write to update topic files, which automatically rebuilds the index.",
        errorKind: "permission-denied" as ToolErrorKind,
        errorCode: "MEMORY_INDEX_WRITE_DENIED",
      };
    }

    if (resolvedInput.endsWith(join(sep, MEMORY_INDEX_SUFFIX))) {
      return {
        outcome: "deny",
        reason:
          "Memory index is system-managed and cannot be edited directly. " +
          "Use memory_write to update topic files, which automatically rebuilds the index.",
        errorKind: "permission-denied" as ToolErrorKind,
        errorCode: "MEMORY_INDEX_WRITE_DENIED",
      };
    }

    return { outcome: "allow" };
  };
}