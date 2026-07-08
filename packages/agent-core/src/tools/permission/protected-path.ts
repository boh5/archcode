import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import type { PermissionDecision, ToolPermission, ToolExecutionContext } from "../types";
import type { ToolErrorKind } from "../errors";

const PROJECT_DIR_SUFFIX = join(PROJECT_STATE_DIR_NAME);
const PROJECT_DIR_REFERENCE_PATTERN = escapeRegExp(PROJECT_STATE_DIR_NAME);
const PROJECT_DIR_REFERENCE_RE = new RegExp(`(^|[^A-Za-z0-9._-])(?:\\./)?${PROJECT_DIR_REFERENCE_PATTERN}(?=$|[^A-Za-z0-9._-])`);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

export function isProtectedProjectPath(filePath: string, workspaceRoot: string): boolean {
  const inputAbsolute = resolve(workspaceRoot, filePath);
  const resolvedInput = resolveRealPath(inputAbsolute);

  const projectDir = resolve(workspaceRoot, PROJECT_DIR_SUFFIX);
  const resolvedProjectDir = resolveRealPath(projectDir);

  return resolvedInput.startsWith(resolvedProjectDir + sep) || resolvedInput === resolvedProjectDir;
}

/**
 * Creates a permission guard that denies direct mutation of any file or
 * directory under the project state directory. This protects the entire
 * system-managed project state tree from being modified by ordinary file mutation
 * tools (file_write, file_edit), ensuring only internal managers (memory,
 * Goal artifact, project approval managers) may mutate these paths via direct
 * filesystem APIs.
 *
 * The guard performs symlink-safe realpath resolution to prevent traversal
 * attacks.
 */
export function createProtectedPathPermission(): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    const data = input as { path?: unknown; paths?: unknown; cwd?: unknown; command?: unknown };
    const paths = protectedPathReferences(data);

    for (const path of paths) {
      if (isProtectedProjectPath(path, ctx.workspaceRoot)) {
        return denyProtectedPathMutation();
      }
    }

    if (typeof data.command === "string" && PROJECT_DIR_REFERENCE_RE.test(data.command)) {
      return denyProtectedPathMutation();
    }

    return { outcome: "allow" };
  };
}

function protectedPathReferences(data: { path?: unknown; paths?: unknown; cwd?: unknown }): string[] {
  const paths: string[] = [];
  if (typeof data.path === "string") paths.push(data.path);
  if (typeof data.cwd === "string") paths.push(data.cwd);
  if (Array.isArray(data.paths)) {
    for (const path of data.paths) {
      if (typeof path === "string") paths.push(path);
    }
  }
  return paths;
}

function denyProtectedPathMutation(): PermissionDecision {
  return {
    outcome: "deny",
    reason:
      `The ${PROJECT_STATE_DIR_NAME}/ directory is system-managed and cannot be edited directly. ` +
      "Use the appropriate internal lifecycle tools to modify files in this directory.",
    errorKind: "permission-denied" as ToolErrorKind,
    errorCode: "PROTECTED_PATH_WRITE_DENIED",
  };
}
