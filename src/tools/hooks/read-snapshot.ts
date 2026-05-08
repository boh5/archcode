import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/index";
import type {
  AfterHook,
  GuardDecision,
  GuardHook,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../types";

// ─── LRU limit ───

const MAX_SNAPSHOTS = 1024;

// ─── Path resolution ───

/**
 * Resolve a file path against workspaceRoot, follow symlinks,
 * and check whether the result stays within the workspace boundary.
 *
 * When the file does not exist, `realpathSync.native()` falls back
 * to the unresolvable absolute path so callers can still do
 * boundary / snapshot checks.
 */
/**
 * Walk up the directory tree from `p` until we find an existing ancestor,
 * resolve its real path via `realpathSync.native()`, then append the
 * non-existent tail.  Handles the case where a prefix of the path contains
 * a symlink (e.g. `/var` → `/private/var` on macOS).
 */
function tryResolveChain(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(tryResolveChain(parent), path.basename(p));
  }
}

export function resolveAndValidatePath(
  inputPath: string,
  workspaceRoot: string,
): { resolved: string; isWithinWorkspace: boolean } {
  const absolutePath = path.resolve(workspaceRoot, inputPath);
  let resolved: string;
  try {
    resolved = realpathSync.native(absolutePath);
  } catch {
    resolved = tryResolveChain(absolutePath);
  }
  let workspaceReal: string;
  try {
    workspaceReal = realpathSync.native(path.resolve(workspaceRoot));
  } catch {
    workspaceReal = path.resolve(workspaceRoot);
  }
  const isWithinWorkspace =
    resolved === workspaceReal || resolved.startsWith(workspaceReal + path.sep);
  return { resolved, isWithinWorkspace };
}

// ─── After hook — record read snapshot ───

/**
 * After-hook for `file_read`: records the file's realpath → mtimeMs
 * into `ctx.store.readSnapshots` so that subsequent edit guards can
 * verify the file was recently read and hasn't changed.
 *
 * Skips recording when the tool execution failed (`isError === true`).
 *
 * Enforces an LRU eviction policy: when the map already holds 1024
 * entries the oldest (first-inserted) entry is dropped.
 */
export function createReadSnapshotAfterHook(): AfterHook {
  return (result: ToolExecutionResult, ctx: ToolExecutionContext) => {
    if (result.isError) return;

    const inputRecord = ctx.input as { path: string };
    const { resolved } = resolveAndValidatePath(
      inputRecord.path,
      ctx.workspaceRoot,
    );

    let mtimeMs: number;
    try {
      mtimeMs = statSync(resolved).mtimeMs;
    } catch {
      // File may have been deleted between read and hook execution
      return;
    }

    const store = ctx.store;
    const state = store.getState();
    const snapshots = new Map(state.readSnapshots);

    // LRU eviction: drop the oldest entry when at capacity
    if (snapshots.size >= MAX_SNAPSHOTS) {
      const oldest = snapshots.keys().next().value;
      if (oldest !== undefined) {
        snapshots.delete(oldest);
      }
    }

    snapshots.set(resolved, mtimeMs);
    store.setState({ readSnapshots: snapshots });
  };
}

// ─── Guard — verify file was read before edit ───

/**
 * Guard for `file_edit`: denies the edit if:
 *  1. The target file was never read (not in `readSnapshots`), or
 *  2. The file's mtime on disk differs from the recorded snapshot
 *     (indicating an external modification).
 */
export function createReadBeforeEditGuard(): GuardHook {
  return (input: unknown, ctx: ToolExecutionContext): GuardDecision => {
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

// ─── Guard — workspace boundary ───

/**
 * Guard that ensures the requested file path resolves inside
 * `ctx.workspaceRoot`. Denies access to paths that escape the
 * workspace via `..` or symlinks.
 */
export function createWorkspaceGuard(): GuardHook {
  return (input: unknown, ctx: ToolExecutionContext): GuardDecision => {
    const inputRecord = input as { path?: string };
    if (!inputRecord.path) {
      return { outcome: "allow" };
    }

    const { resolved, isWithinWorkspace } = resolveAndValidatePath(
      inputRecord.path,
      ctx.workspaceRoot,
    );

    if (!isWithinWorkspace) {
      return {
        outcome: "deny",
        reason: `"${resolved}" is outside workspace "${ctx.workspaceRoot}" [TOOL_FILE_OUTSIDE_WORKSPACE]`,
      };
    }

    return { outcome: "allow" };
  };
}

// ─── Sensitive file detection ───

export const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env$/,
  /^\.env\..+$/, // .env files
  /.*\.pem$/,
  /.*\.key$/,
  /.*\.p12$/, // private keys
  /^id_rsa.*$/,
  /^id_ed25519.*$/, // SSH keys
  /^\.gitconfig$/, // git config
  /^\.bashrc$/,
  /^\.zshrc$/, // shell config
  /^\.npmrc$/, // npm config (may contain tokens)
];

export function isSensitiveFile(basename: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(basename));
}

// ─── Guard — sensitive file confirmation ───

/**
 * Guard for `file_read` / `file_write`: returns `"ask"` when the
 * target file basename matches a sensitive-file pattern, prompting
 * the user for confirmation.
 */
export function createSensitiveFileGuard(): GuardHook {
  return (input: unknown, _ctx: ToolExecutionContext): GuardDecision => {
    const inputRecord = input as { path: string };
    const basename = path.basename(inputRecord.path);

    if (isSensitiveFile(basename)) {
      return {
        outcome: "ask",
        reason: `File "${basename}" is a sensitive file.`,
        prompt: `Are you sure you want to access "${inputRecord.path}"? This file may contain secrets or credentials.`,
      };
    }

    return { outcome: "allow" };
  };
}

// ─── Snapshot lifecycle helpers ───

/**
 * Re-stat a file and update its snapshot entry.
 * Called after successful `file_write` / `file_edit`.
 */
export function refreshReadSnapshot(
  filePath: string,
  store: StoreApi<SessionStoreState>,
  workspaceRoot: string,
): void {
  const { resolved } = resolveAndValidatePath(filePath, workspaceRoot);

  let mtimeMs: number;
  try {
    mtimeMs = statSync(resolved).mtimeMs;
  } catch {
    // File may have been deleted after write/edit; skip snapshot update
    return;
  }

  const state = store.getState();
  const snapshots = new Map(state.readSnapshots);
  snapshots.set(resolved, mtimeMs);
  store.setState({ readSnapshots: snapshots });
}

export function invalidateReadSnapshot(
  filePath: string,
  store: StoreApi<SessionStoreState>,
  workspaceRoot: string,
): void {
  const { resolved } = resolveAndValidatePath(filePath, workspaceRoot);
  const state = store.getState();
  const snapshots = new Map(state.readSnapshots);
  snapshots.delete(resolved);
  store.setState({ readSnapshots: snapshots });
}
