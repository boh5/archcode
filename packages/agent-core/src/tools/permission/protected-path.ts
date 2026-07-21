import { realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import type { PermissionDecision, ToolPermission, ToolExecutionContext } from "../types";
import type { ToolErrorKind } from "../errors";

const PROJECT_DIR_SUFFIX = join(PROJECT_STATE_DIR_NAME);

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
  return isLexicalProjectStatePath(lexicalInput, workspaceRoot)
    || isResolvedProjectStatePath(resolveRealPath(lexicalInput), workspaceRoot);
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

/** Checks an already operation-aware canonical Bash access without following its leaf again. */
export function isProtectedCanonicalWritePath(
  effectiveCanonicalPath: string,
  ctx: Pick<ToolExecutionContext, "cwd" | "projectContext">,
): boolean {
  for (const root of new Set([ctx.cwd, ctx.projectContext.project.workspaceRoot])) {
    const lexicalRoot = resolve(root);
    const resolvedRoot = resolveRealPath(lexicalRoot);
    const lexicalGit = resolve(lexicalRoot, ".git");
    const resolvedGit = resolveRealPath(lexicalGit);
    if (
      isLexicalProjectStatePath(effectiveCanonicalPath, root)
      || isResolvedProjectStatePath(effectiveCanonicalPath, root)
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
      isLexicalProjectStatePath(lexicalInput, root)
      || isResolvedProjectStatePath(resolvedInput, root)
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

function isLexicalProjectStatePath(input: string, projectRoot: string): boolean {
  const lexicalRoot = resolve(projectRoot);
  const resolvedRoot = resolveRealPath(lexicalRoot);
  return isAtOrBelow(input, resolve(lexicalRoot, PROJECT_DIR_SUFFIX))
    || isAtOrBelow(input, resolve(resolvedRoot, PROJECT_DIR_SUFFIX));
}

/**
 * Creates a permission guard that denies direct mutation of project state and
 * Git metadata. This protects both system-managed trees from ordinary file
 * mutation tools (file_write, file_edit) while
 * keeping lifecycle managers and normal Git CLI operations on their dedicated
 * paths.
 *
 * The guard performs symlink-safe realpath resolution to prevent traversal
 * attacks.
 */
export function createProtectedPathPermission(): ToolPermission {
  return async (input: unknown, ctx: ToolExecutionContext): Promise<PermissionDecision> => {
    const data = input as { path?: unknown; paths?: unknown; cwd?: unknown };
    const paths = protectedPathReferences(data);

    for (const path of paths) {
      if (isProtectedToolWritePath(path, ctx)) {
        if (await mayWriteLeadPlan(path, ctx)) continue;
        return denyProtectedPathMutation();
      }
    }

    return { outcome: "allow" };
  };
}

async function mayWriteLeadPlan(filePath: string, ctx: ToolExecutionContext): Promise<boolean> {
  if (ctx.toolName !== "file_write" && ctx.toolName !== "file_edit") return false;
  const lexicalInput = resolve(ctx.cwd, filePath);
  if (extname(lexicalInput) !== ".md") return false;
  const candidateRoots = [...new Set([ctx.cwd, ctx.projectContext.project.workspaceRoot])]
    .filter((root) => dirname(lexicalInput) === resolve(root, PROJECT_DIR_SUFFIX, "plans"));
  if (candidateRoots.length === 0) return false;
  if (typeof ctx.store.getState !== "function") return false;
  const state = ctx.store.getState();
  const agentName = ctx.agentName ?? state.agentName;
  if (
    agentName !== "lead"
    || state.agentName !== "lead"
    || state.sessionId !== state.rootSessionId
    || state.parentSessionId !== undefined
  ) return false;

  const discussion = await ctx.projectContext.todos.state.findByDiscussionSessionId(state.sessionId);
  if (discussion !== undefined) return false;

  for (const root of candidateRoots) {
    const lexicalPlans = resolve(root, PROJECT_DIR_SUFFIX, "plans");
    if (dirname(lexicalInput) !== lexicalPlans) continue;
    const resolvedProjectState = resolveRealPath(resolve(root, PROJECT_DIR_SUFFIX));
    const resolvedPlans = resolveRealPath(lexicalPlans);
    if (resolvedPlans !== resolve(resolvedProjectState, "plans")) return false;
    if (dirname(resolveRealPath(lexicalInput)) !== resolvedPlans) return false;
    return true;
  }
  return false;
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
