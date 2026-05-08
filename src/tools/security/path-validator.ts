import { realpathSync } from "node:fs";
import path from "node:path";

export type PathValidationErrorCode = "PATH_OUTSIDE_WORKSPACE";

export interface PathValidationError {
  code: PathValidationErrorCode;
  inputPath: string;
  absolutePath: string;
  resolvedPath: string;
  workspaceRoot: string;
  workspaceRealPath: string;
}

export interface PathValidationResult {
  ok: boolean;
  inputPath: string;
  absolutePath: string;
  resolvedPath: string;
  workspaceRoot: string;
  workspaceRealPath: string;
  error?: PathValidationError;
}

export interface ResolveAndValidatePathResult {
  resolved: string;
  isWithinWorkspace: boolean;
}

/**
 * Walk up to the nearest existing ancestor, resolve that real path, then
 * append the nonexistent tail so symlinked ancestors are still canonicalized.
 */
function resolveExistingAncestorWithTail(absolutePath: string): string {
  try {
    return realpathSync.native(absolutePath);
  } catch {
    const parent = path.dirname(absolutePath);
    if (parent === absolutePath) return absolutePath;
    return path.join(
      resolveExistingAncestorWithTail(parent),
      path.basename(absolutePath),
    );
  }
}

function resolveWorkspaceRoot(workspaceRoot: string): string {
  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);
  try {
    return realpathSync.native(absoluteWorkspaceRoot);
  } catch {
    return absoluteWorkspaceRoot;
  }
}

function isInsideWorkspace(resolvedPath: string, workspaceRealPath: string): boolean {
  return (
    resolvedPath === workspaceRealPath ||
    resolvedPath.startsWith(workspaceRealPath + path.sep)
  );
}

export class PathValidator {
  readonly workspaceRoot: string;
  readonly workspaceRealPath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.workspaceRealPath = resolveWorkspaceRoot(this.workspaceRoot);
  }

  validate(inputPath: string): PathValidationResult {
    const absolutePath = path.resolve(this.workspaceRoot, inputPath);
    const resolvedPath = resolveExistingAncestorWithTail(absolutePath);
    const ok = isInsideWorkspace(resolvedPath, this.workspaceRealPath);
    const result: PathValidationResult = {
      ok,
      inputPath,
      absolutePath,
      resolvedPath,
      workspaceRoot: this.workspaceRoot,
      workspaceRealPath: this.workspaceRealPath,
    };

    if (!ok) {
      result.error = {
        code: "PATH_OUTSIDE_WORKSPACE",
        inputPath,
        absolutePath,
        resolvedPath,
        workspaceRoot: this.workspaceRoot,
        workspaceRealPath: this.workspaceRealPath,
      };
    }

    return result;
  }

  resolveAndValidate(inputPath: string): ResolveAndValidatePathResult {
    const result = this.validate(inputPath);
    return {
      resolved: result.resolvedPath,
      isWithinWorkspace: result.ok,
    };
  }
}

export function createPathValidator(workspaceRoot: string): PathValidator {
  return new PathValidator(workspaceRoot);
}

export function validateWorkspacePath(
  inputPath: string,
  workspaceRoot: string,
): PathValidationResult {
  return new PathValidator(workspaceRoot).validate(inputPath);
}

export function resolveAndValidatePath(
  inputPath: string,
  workspaceRoot: string,
): ResolveAndValidatePathResult {
  return new PathValidator(workspaceRoot).resolveAndValidate(inputPath);
}
