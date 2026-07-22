import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROJECT_RUNTIME_DIR_NAME, PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import type { PermissionDecision, ToolPermission, ToolExecutionContext } from "../types";
import type { ToolErrorKind } from "../errors";

const RUNTIME_DIR_SUFFIX = join(PROJECT_STATE_DIR_NAME, PROJECT_RUNTIME_DIR_NAME);

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
  const lexicalInput = resolve(workspaceRoot, filePath);
  return isLexicalRuntimePath(lexicalInput, workspaceRoot)
    || isResolvedRuntimePath(resolveRealPath(lexicalInput), workspaceRoot);
}

/**
 * Returns whether a tool mutation path targets or contains system-managed
 * project runtime state. Relative inputs resolve from the current Session
 * working directory, while protection covers both that directory and the
 * canonical project root.
 */
export function isProtectedToolWritePath(
  filePath: string,
  ctx: Pick<ToolExecutionContext, "cwd" | "projectContext">,
): boolean {
  return isProtectedToolWritePathFrom(filePath, ctx.cwd, ctx);
}

/** Checks whether an already canonical mutation path intersects protected state. */
export function isProtectedCanonicalMutationPath(
  effectiveCanonicalPath: string,
  ctx: Pick<ToolExecutionContext, "cwd" | "projectContext">,
): boolean {
  for (const root of new Set([ctx.cwd, ctx.projectContext.project.workspaceRoot])) {
    const lexicalRoot = resolve(root);
    const resolvedRoot = resolveRealPath(lexicalRoot);
    const lexicalGit = resolve(lexicalRoot, ".git");
    const resolvedGit = resolveRealPath(lexicalGit);
    if (
      isRuntimeTreeOverlap(effectiveCanonicalPath, root)
      || isAtOrBelow(effectiveCanonicalPath, lexicalGit)
      || isAtOrBelow(effectiveCanonicalPath, resolvedGit)
      || hasPathComponentWithin(effectiveCanonicalPath, resolvedRoot, ".git")
    ) return true;
  }
  return false;
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
      isRuntimeTreeOverlap(lexicalInput, root)
      || isRuntimeTreeOverlap(resolvedInput, root)
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

function treesOverlap(left: string, right: string): boolean {
  return isAtOrBelow(left, right) || isAtOrBelow(right, left);
}

function hasPathComponentWithin(candidate: string, root: string, component: string): boolean {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    return false;
  }
  return pathFromRoot.split(sep).includes(component);
}

function isResolvedRuntimePath(resolvedInput: string, projectRoot: string): boolean {
  const runtimeDir = resolve(projectRoot, RUNTIME_DIR_SUFFIX);
  const resolvedRuntimeDir = resolveRealPath(runtimeDir);

  return resolvedInput.startsWith(resolvedRuntimeDir + sep) || resolvedInput === resolvedRuntimeDir;
}

function isLexicalRuntimePath(input: string, projectRoot: string): boolean {
  const lexicalRoot = resolve(projectRoot);
  const resolvedRoot = resolveRealPath(lexicalRoot);
  return isAtOrBelow(input, resolve(lexicalRoot, RUNTIME_DIR_SUFFIX))
    || isAtOrBelow(input, resolve(resolvedRoot, RUNTIME_DIR_SUFFIX));
}

function isRuntimeTreeOverlap(input: string, projectRoot: string): boolean {
  const lexicalRoot = resolve(projectRoot);
  const resolvedRoot = resolveRealPath(lexicalRoot);
  const lexicalRuntime = resolve(lexicalRoot, RUNTIME_DIR_SUFFIX);
  const resolvedRootRuntime = resolve(resolvedRoot, RUNTIME_DIR_SUFFIX);
  const resolvedRuntime = resolveRealPath(lexicalRuntime);
  return treesOverlap(input, lexicalRuntime)
    || treesOverlap(input, resolvedRootRuntime)
    || treesOverlap(input, resolvedRuntime);
}

function isProtectedToolSelectionPath(
  filePath: string,
  ctx: Pick<ToolExecutionContext, "cwd" | "projectContext">,
): boolean {
  const lexicalInput = resolve(ctx.cwd, filePath);
  const resolvedInput = resolveRealPath(lexicalInput);
  for (const root of new Set([ctx.cwd, ctx.projectContext.project.workspaceRoot])) {
    if (
      isLexicalRuntimePath(lexicalInput, root)
      || isResolvedRuntimePath(resolvedInput, root)
      || isGitMetadataPath(lexicalInput, resolvedInput, root)
    ) return true;
  }
  return false;
}

/**
 * Creates a permission guard that denies direct mutation of project runtime
 * state, ancestors whose mutation would affect it, and Git metadata. This keeps
 * lifecycle managers and normal Git CLI operations on their dedicated paths.
 * Direct plan, Skill, and other non-runtime `.archcode` artifact mutations stay
 * outside the protected runtime tree.
 *
 * The guard performs symlink-safe realpath resolution to prevent traversal
 * attacks.
 */
export function createProtectedPathPermission(): ToolPermission {
  return async (input: unknown, ctx: ToolExecutionContext): Promise<PermissionDecision> => {
    const data = input as { path?: unknown; paths?: unknown; cwd?: unknown };
    const references = protectedPathReferences(data);

    for (const reference of references) {
      const protectedPath = reference.kind === "selection"
        ? isProtectedToolSelectionPath(reference.path, ctx)
        : isProtectedToolWritePath(reference.path, ctx);
      if (protectedPath) {
        return denyProtectedPathMutation();
      }
    }

    return { outcome: "allow" };
  };
}

function protectedPathReferences(
  data: { path?: unknown; paths?: unknown; cwd?: unknown },
): Array<{ readonly path: string; readonly kind: "mutation" | "selection" }> {
  const paths: Array<{ readonly path: string; readonly kind: "mutation" | "selection" }> = [];
  if (typeof data.path === "string") paths.push({ path: data.path, kind: "mutation" });
  if (typeof data.cwd === "string") paths.push({ path: data.cwd, kind: "mutation" });
  if (Array.isArray(data.paths)) {
    for (const path of data.paths) {
      if (typeof path === "string") paths.push({ path, kind: "selection" });
    }
  }
  return paths;
}

function denyProtectedPathMutation(): PermissionDecision {
  return {
    outcome: "deny",
    reason:
      `Mutations intersecting ${PROJECT_STATE_DIR_NAME}/${PROJECT_RUNTIME_DIR_NAME}/ and Git metadata are system-managed and cannot be performed directly. ` +
      "Use the appropriate internal lifecycle or Git tools instead.",
    errorKind: "permission-denied" as ToolErrorKind,
    errorCode: "PROTECTED_PATH_WRITE_DENIED",
  };
}
