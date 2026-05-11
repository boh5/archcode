import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { GuardDecision, GuardHook, ToolExecutionContext } from "../types";
import type { ToolErrorKind } from "../errors";

/** Relative path from workspace root to the system-managed memory index. */
const MEMORY_INDEX_SUFFIX = join(".specra", "memory", "index.md");

/**
 * Walk up to the nearest existing ancestor, resolve its real path, then
 * append the nonexistent tail. Mirrors the approach in
 * {@link import("../security/path-validator").resolveExistingAncestorWithTail}.
 */
function resolveRealPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    const parent = resolve(filePath, "..");
    // Guard against infinite recursion at filesystem root.
    if (parent === filePath) return filePath;
    return join(resolveRealPath(parent), filePath.slice(filePath.lastIndexOf(sep) + 1));
  }
}

/**
 * Create a guard that denies writes/edits targeting the system-managed
 * `.specra/memory/index.md` file. The memory index is rebuilt automatically
 * by `memory_write` — direct edits would be overwritten.
 *
 * Works with both `file_write` and `file_edit` tools (both have a `path`
 * field in their input). Handles:
 * - Direct relative paths  (`.specra/memory/index.md`)
 * - Absolute paths         (`/workspace/.specra/memory/index.md`)
 * - Path traversal         (`.specra/memory/knowledge/../index.md`)
 * - Symlink targets        (when the resolved file points to the index)
 */
export function createMemoryIndexGuard(): GuardHook {
  return (input: unknown, ctx: ToolExecutionContext): GuardDecision => {
    const data = input as { path?: string };
    if (!data.path) {
      return { outcome: "allow" };
    }

    // Resolve the user-provided path relative to the workspace root,
    // then resolve any symlinks along the way.
    const inputAbsolute = resolve(ctx.workspaceRoot, data.path);
    const resolvedInput = resolveRealPath(inputAbsolute);

    // Build the canonical expected index path (symlink-resolved).
    const expectedIndexPath = resolve(ctx.workspaceRoot, MEMORY_INDEX_SUFFIX);
    const resolvedExpected = resolveRealPath(expectedIndexPath);

    // 1. Direct equality check (handles symlinks, traversal).
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

    // 2. Belt-and-suspenders: check the resolved path ends with the
    //    `.specra/memory/index.md` suffix so that alternate resolutions
    //    that happen to land on the same logical file are also caught.
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
