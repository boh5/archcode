import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import type { PermissionDecision, ToolPermission, ToolExecutionContext } from "../types";
import type { ToolErrorKind } from "../errors";
import { parseShellRequest } from "../security/bash/parse";

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
  return isResolvedProjectStatePath(
    resolveRealPath(resolve(workspaceRoot, filePath)),
    workspaceRoot,
  );
}

/**
 * Returns whether a tool mutation path targets system-managed project state.
 * Relative inputs resolve from the current Session working directory, while
 * protection covers both that directory and the canonical project root.
 */
export function isProtectedToolWritePath(
  filePath: string,
  ctx: Pick<ToolExecutionContext, "cwd" | "projectContext">,
): boolean {
  return isProtectedToolWritePathFrom(filePath, ctx.cwd, ctx);
}

function isProtectedToolWritePathFrom(
  filePath: string,
  cwd: string,
  ctx: Pick<ToolExecutionContext, "cwd" | "projectContext">,
): boolean {
  const lexicalInput = resolve(cwd, filePath);
  const resolvedInput = resolveRealPath(lexicalInput);
  const protectedRoots = new Set([
    ctx.cwd,
    ctx.projectContext.project.workspaceRoot,
  ]);

  for (const root of protectedRoots) {
    if (
      isResolvedProjectStatePath(resolvedInput, root)
      || isGitMetadataPath(lexicalInput, resolvedInput, root)
    ) return true;
  }

  return false;
}

function isGitMetadataPath(lexicalInput: string, resolvedInput: string, projectRoot: string): boolean {
  const lexicalRoot = resolve(projectRoot);
  const resolvedRoot = resolveRealPath(lexicalRoot);
  const lexicalGit = resolve(lexicalRoot, ".git");
  const resolvedGit = resolveRealPath(lexicalGit);
  if (
    isAtOrBelow(lexicalInput, lexicalGit)
    || isAtOrBelow(resolvedInput, resolvedGit)
    || isAtOrBelow(resolvedInput, lexicalGit)
  ) return true;

  return hasPathComponentWithin(lexicalInput, lexicalRoot, ".git")
    || hasPathComponentWithin(resolvedInput, resolvedRoot, ".git");
}

function isAtOrBelow(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function hasPathComponentWithin(candidate: string, root: string, component: string): boolean {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    return false;
  }
  return pathFromRoot.split(sep).includes(component);
}

function isResolvedProjectStatePath(resolvedInput: string, projectRoot: string): boolean {
  const projectDir = resolve(projectRoot, PROJECT_DIR_SUFFIX);
  const resolvedProjectDir = resolveRealPath(projectDir);

  return resolvedInput.startsWith(resolvedProjectDir + sep) || resolvedInput === resolvedProjectDir;
}

/**
 * Creates a permission guard that denies direct mutation of project state and
 * Git metadata. This protects both system-managed trees from ordinary file
 * mutation tools (file_write, file_edit) and parsed Bash path effects while
 * keeping lifecycle managers and normal Git CLI operations on their dedicated
 * paths.
 *
 * The guard performs symlink-safe realpath resolution to prevent traversal
 * attacks.
 */
export function createProtectedPathPermission(): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    const data = input as { path?: unknown; paths?: unknown; cwd?: unknown; command?: unknown };
    const paths = protectedPathReferences(data);

    for (const path of paths) {
      if (isProtectedToolWritePath(path, ctx)) {
        return denyProtectedPathMutation();
      }
    }

    if (typeof data.command === "string") {
      const parsed = parseShellRequest(data.command, {
        workspaceRoot: ctx.cwd,
        ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {}),
      });
      if ("invocations" in parsed) {
        for (const invocation of parsed.invocations) {
          for (const path of invocation.paths) {
            if (
              path.operation !== "read"
              && path.operation !== "execute"
              && isProtectedToolWritePathFrom(path.path, invocation.cwd, ctx)
            ) {
              return denyProtectedPathMutation();
            }
          }
        }
      }

      if (PROJECT_DIR_REFERENCE_RE.test(data.command)) return denyProtectedPathMutation();
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
      `The ${PROJECT_STATE_DIR_NAME}/ directory and Git metadata are system-managed and cannot be edited directly. ` +
      "Use the appropriate internal lifecycle or Git tools instead.",
    errorKind: "permission-denied" as ToolErrorKind,
    errorCode: "PROTECTED_PATH_WRITE_DENIED",
  };
}
