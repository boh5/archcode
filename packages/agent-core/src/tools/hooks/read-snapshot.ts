import { statSync } from "node:fs";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/index";
import { resolveAndValidatePath } from "../security";
import type {
  AfterHook,
  ToolExecutionResult,
  ToolExecutionContext,
} from "../types";

// ─── LRU limit ───

const MAX_SNAPSHOTS = 1024;

// ─── After hook — record read snapshot ───

/**
 * After-hook for `file_read`: records the file's realpath → mtimeMs
 * into `ctx.store.readSnapshots` so that subsequent edit permissions can
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
      ctx.cwd,
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
