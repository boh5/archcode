import { statSync } from "node:fs";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/index";
import { resolveAndValidatePath } from "../security/path-validator";
import type {
  AfterHook,
  GuardDecision,
  GuardHook,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../types";

// ─── LRU limit ───

const MAX_SNAPSHOTS = 1024;

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
