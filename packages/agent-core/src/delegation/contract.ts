import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import type { DelegationRequest, ScopeRef } from "@archcode/protocol";

const GLOB_META = /[*?\[\]{}]/;

export class InvalidScopeRefError extends Error {
  constructor(
    public readonly scope: ScopeRef,
    public readonly reason: string,
  ) {
    super(`Invalid ${scope.kind} scope "${scope.path}": ${reason}`);
    this.name = "InvalidScopeRefError";
  }
}

/** Pure syntax normalization. Filesystem containment is checked separately. */
export function normalizeScopeRef(scope: ScopeRef): ScopeRef {
  const raw = scope.path.trim();
  if (raw.length === 0) throw new InvalidScopeRefError(scope, "path must not be empty");
  if (raw.includes("\0")) throw new InvalidScopeRefError(scope, "path contains a null byte");
  if (raw.includes("\\")) throw new InvalidScopeRefError(scope, "path must use canonical forward slashes");
  if (isAbsolute(raw) || win32.isAbsolute(raw)) {
    throw new InvalidScopeRefError(scope, "absolute paths are not allowed");
  }
  if (GLOB_META.test(raw)) throw new InvalidScopeRefError(scope, "glob syntax is not allowed");

  const segments = raw.split("/");
  if (segments.includes("..")) throw new InvalidScopeRefError(scope, "parent traversal is not allowed");

  const path = posix.normalize(raw).replace(/^\.\//, "");
  if (path === ".." || path.startsWith("../")) {
    throw new InvalidScopeRefError(scope, "path escapes the workspace");
  }
  if (scope.kind === "file" && path === ".") {
    throw new InvalidScopeRefError(scope, "file scope must identify a file path");
  }
  return { kind: scope.kind, path };
}

/**
 * Resolves the target, or its nearest existing ancestor, before accepting the
 * canonical relative path. This rejects symlink escapes even for missing leafs.
 */
export async function validateScopeRefInWorkspace(
  scope: ScopeRef,
  workspaceRoot: string,
): Promise<ScopeRef> {
  const normalized = normalizeScopeRef(scope);
  const realRoot = await realpath(workspaceRoot);
  const target = resolve(realRoot, ...normalized.path.split("/"));
  const existingAncestor = await nearestExistingAncestor(target, realRoot, normalized);
  const realAncestor = await realpath(existingAncestor);
  const missingSuffix = relative(existingAncestor, target);
  const canonicalTarget = resolve(realAncestor, missingSuffix);

  if (!isPathWithin(realRoot, realAncestor) || !isPathWithin(realRoot, canonicalTarget)) {
    throw new InvalidScopeRefError(normalized, "path resolves outside the workspace through a symlink");
  }

  const canonicalPath = relative(realRoot, canonicalTarget).split(sep).join("/") || ".";
  if (normalized.kind === "file" && canonicalPath === ".") {
    throw new InvalidScopeRefError(normalized, "file scope resolves to the workspace root");
  }
  return { kind: normalized.kind, path: canonicalPath };
}

export async function validateDelegationScopes(
  request: DelegationRequest,
  workspaceRoot: string,
): Promise<DelegationRequest> {
  const ownedScope = await Promise.all(
    request.owned_scope.map((scope) => validateScopeRefInWorkspace(scope, workspaceRoot)),
  );
  return { ...request, owned_scope: ownedScope };
}

/** True for exact path equality or when either tree owns the other's path. */
export function scopeRefsOverlap(left: ScopeRef, right: ScopeRef): boolean {
  const a = normalizeScopeRef(left);
  const b = normalizeScopeRef(right);
  if (a.path === b.path) return true;
  return (a.kind === "tree" && isRelativeAncestor(a.path, b.path))
    || (b.kind === "tree" && isRelativeAncestor(b.path, a.path));
}

export function delegationScopesOverlap(
  left: readonly ScopeRef[],
  right: readonly ScopeRef[],
): boolean {
  return left.some((a) => right.some((b) => scopeRefsOverlap(a, b)));
}

async function nearestExistingAncestor(
  target: string,
  workspaceRoot: string,
  scope: ScopeRef,
): Promise<string> {
  let cursor = target;
  while (true) {
    try {
      await lstat(cursor);
      return cursor;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }

    if (cursor === workspaceRoot) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor || !isPathWithin(workspaceRoot, parent)) {
      throw new InvalidScopeRefError(scope, "path has no existing ancestor inside the workspace");
    }
    cursor = parent;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isRelativeAncestor(ancestor: string, candidate: string): boolean {
  if (ancestor === ".") return candidate !== ".";
  return candidate.startsWith(`${ancestor}/`);
}
