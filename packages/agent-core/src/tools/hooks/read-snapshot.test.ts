import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { storeManager } from "../../store/store";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockStore } from "../../store/test-helpers";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  createReadSnapshotAfterHook,
  refreshReadSnapshot,
  invalidateReadSnapshot,
} from "./read-snapshot";
import { resolveAndValidatePath } from "../security";
import { createTestProjectContext } from "../test-project-context";

// ─── Test dirs ───

let workspaceDir: string;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "rs-workspace-"));
  mkdirSync(join(workspaceDir, "subdir"), { recursive: true });
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ─── Helpers ───

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "file_read",
  toolCallId: "call-1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["file_read", "file_edit", "file_write"]),
  cwd: workspaceDir,
  storeManager,
    projectContext: createTestProjectContext(workspaceDir), ...overrides,  };
}

function makeResult(
  overrides: Partial<ToolExecutionResult> = {},
): ToolExecutionResult {
  return { output: "",
  isError: false,
  meta: {}, ...overrides,  };
}

/** Create a file inside workspaceDir and return its absolute path. */
function workspaceFile(name: string): string {
  const p = join(workspaceDir, name);
  writeFileSync(p, "content", "utf-8");
  return p;
}

// ─────────────────────────────────────────────────────────────────────
// resolveAndValidatePath
// ─────────────────────────────────────────────────────────────────────

describe("resolveAndValidatePath", () => {
  test("resolves path within workspace", () => {
    const file = workspaceFile("in-workspace.txt");
    const result = resolveAndValidatePath(file, workspaceDir);
    expect(result.resolved).toBe(realpathSync.native(file));
    expect(result.isWithinWorkspace).toBe(true);
  });

  test("resolves relative path against workspace root", () => {
    const file = join(workspaceDir, "subdir", "relative-test.txt");
    writeFileSync(file, "content", "utf-8");
    const result = resolveAndValidatePath("subdir/relative-test.txt", workspaceDir);
    expect(result.resolved).toBe(realpathSync.native(file));
    expect(result.isWithinWorkspace).toBe(true);
  });

  test("returns resolved path even when file does not exist", () => {
    const result = resolveAndValidatePath("nonexistent/file.txt", workspaceDir);
    const expectedStart = realpathSync.native(workspaceDir);
    expect(result.resolved).toBe(join(expectedStart, "nonexistent", "file.txt"));
    expect(result.isWithinWorkspace).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// createReadSnapshotAfterHook
// ─────────────────────────────────────────────────────────────────────

describe("createReadSnapshotAfterHook", () => {
  test("records path and mtime after successful read", async () => {
    const file = workspaceFile("after-hook-ok.txt");
    const realpath = realpathSync.native(file);
    const store = createMockStore();
    const ctx = makeCtx({ store, input: { path: file }, cwd: workspaceDir });

    const hook = createReadSnapshotAfterHook();
    await hook(makeResult({ output: "content" }), ctx);

    const snapshots = store.getState().readSnapshots;
    expect(snapshots.size).toBe(1);
    expect(snapshots.has(realpath)).toBe(true);
    expect(snapshots.get(realpath)).toBe(statSync(realpath).mtimeMs);
  });

  test("does NOT record on failed read (isError = true)", async () => {
    const file = workspaceFile("after-hook-fail.txt");
    const store = createMockStore();
    const ctx = makeCtx({ store, input: { path: file }, cwd: workspaceDir });

    const hook = createReadSnapshotAfterHook();
    await hook(makeResult({ isError: true, output: "error" }), ctx);

    expect(store.getState().readSnapshots.size).toBe(0);
  });

  test("does not modify the result object", async () => {
    const file = workspaceFile("after-hook-identity.txt");
    const store = createMockStore();
    const ctx = makeCtx({ store, input: { path: file }, cwd: workspaceDir });
    const result = makeResult({ output: "hello" });

    const hook = createReadSnapshotAfterHook();
    const returned = await hook(result, ctx);

    expect(returned).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// refreshReadSnapshot
// ─────────────────────────────────────────────────────────────────────

describe("refreshReadSnapshot", () => {
  test("updates mtimeMs for an existing snapshot entry", () => {
    const file = workspaceFile("refresh.txt");
    const realpath = realpathSync.native(file);
    const snapshots = new Map([[realpath, 999]]);
    const store = createMockStore({ readSnapshots: snapshots });

    refreshReadSnapshot(file, store, workspaceDir);

    const updated = store.getState().readSnapshots.get(realpath);
    expect(updated).toBe(statSync(realpath).mtimeMs);
    expect(updated).not.toBe(999);
  });

  test("adds entry even if not previously snapshotted", () => {
    const file = workspaceFile("refresh-new.txt");
    const realpath = realpathSync.native(file);
    const store = createMockStore();

    refreshReadSnapshot(file, store, workspaceDir);

    expect(store.getState().readSnapshots.get(realpath)).toBe(
      statSync(realpath).mtimeMs,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// invalidateReadSnapshot
// ─────────────────────────────────────────────────────────────────────

describe("invalidateReadSnapshot", () => {
  test("removes existing entry from snapshots", () => {
    const file = workspaceFile("invalidate.txt");
    const realpath = realpathSync.native(file);
    const snapshots = new Map([[realpath, 123]]);
    const store = createMockStore({ readSnapshots: snapshots });

    invalidateReadSnapshot(file, store, workspaceDir);

    expect(store.getState().readSnapshots.has(realpath)).toBe(false);
    expect(store.getState().readSnapshots.size).toBe(0);
  });

  test("does not throw when path is not in snapshots", () => {
    const file = workspaceFile("invalidate-miss.txt");
    const store = createMockStore();

    expect(() => invalidateReadSnapshot(file, store, workspaceDir)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// LRU eviction
// ─────────────────────────────────────────────────────────────────────

describe("LRU eviction", () => {
  test("evicts oldest entry when readSnapshots reaches 1024 entries", async () => {
    const snapshots = new Map<string, number>();
    for (let i = 0; i < 1024; i++) {
      snapshots.set(`/dummy/file-${i}.txt`, i);
    }
    const store = createMockStore({ readSnapshots: snapshots });

    const file = workspaceFile("lru-new.txt");
    const realpath = realpathSync.native(file);
    const ctx = makeCtx({
      store,
      input: { path: file },
      cwd: workspaceDir,
    projectContext: createTestProjectContext(workspaceDir),
    });

    const hook = createReadSnapshotAfterHook();
    await hook(makeResult({ output: "content" }), ctx);

    const state = store.getState().readSnapshots;
    expect(state.size).toBe(1024);
    // Oldest (first inserted) entry evicted
    expect(state.has("/dummy/file-0.txt")).toBe(false);
    // New file recorded
    expect(state.has(realpath)).toBe(true);
  });

  test("does not evict when size is below limit", async () => {
    const snapshots = new Map<string, number>();
    for (let i = 0; i < 100; i++) {
      snapshots.set(`/dummy/file-${i}.txt`, i);
    }
    const store = createMockStore({ readSnapshots: snapshots });

    const file = workspaceFile("lru-below.txt");
    const realpath = realpathSync.native(file);
    const ctx = makeCtx({
      store,
      input: { path: file },
      cwd: workspaceDir,
    projectContext: createTestProjectContext(workspaceDir),
    });

    const hook = createReadSnapshotAfterHook();
    await hook(makeResult({ output: "content" }), ctx);

    expect(store.getState().readSnapshots.size).toBe(101); // 100 + 1
    expect(store.getState().readSnapshots.has(realpath)).toBe(true);
  });
});
