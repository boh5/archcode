import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  symlinkSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/index";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import {
  createReadSnapshotAfterHook,
  createReadBeforeEditGuard,
  createWorkspaceGuard,
  isSensitiveFile,
  createSensitiveFileGuard,
  refreshReadSnapshot,
  invalidateReadSnapshot,
  resolveAndValidatePath,
} from "./read-snapshot";

// ─── Test dirs ───

let testDir: string; // outside workspace
let workspaceDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "rs-test-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "rs-workspace-"));
  mkdirSync(join(workspaceDir, "subdir"), { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ─── Helpers ───

function createMockStore(
  snapshots?: Map<string, number>,
): StoreApi<SessionStoreState> {
  const state: SessionStoreState = {
    sessionId: "test",
    createdAt: Date.now(),
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionIds: new Set(),
    subAgentDescriptions: new Map(),
    isRunning: false,
    isStreamingModel: false,
    streamingTools: {},
    readSnapshots: new Map(snapshots),
    runCount: 0,
    append: () => {},
    toModelMessages: () => [],
  };
  return {
    getState: () => state,
    setState: (partial) => {
      if (typeof partial === "function") {
        const fn = partial as (
          s: SessionStoreState,
        ) => Partial<SessionStoreState>;
        Object.assign(state, fn(state));
      } else {
        Object.assign(state, partial);
      }
    },
    getInitialState: () => state,
    subscribe: () => () => {},
  };
}

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "file_read",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["file_read", "file_edit", "file_write"]),
    workspaceRoot: workspaceDir,
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<ToolExecutionResult> = {},
): ToolExecutionResult {
  return {
    output: "",
    isError: false,
    meta: {},
    ...overrides,
  };
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

  test("detects path outside workspace", () => {
    const outsideFile = join(testDir, "outside.txt");
    writeFileSync(outsideFile, "content", "utf-8");
    const result = resolveAndValidatePath(outsideFile, workspaceDir);
    expect(result.isWithinWorkspace).toBe(false);
  });

  test("resolves symlinks to real path", () => {
    const target = workspaceFile("sym-target.txt");
    const link = join(workspaceDir, "sym-link.txt");
    symlinkSync(target, link);
    const result = resolveAndValidatePath(link, workspaceDir);
    expect(result.resolved).toBe(realpathSync.native(target));
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
    const ctx = makeCtx({ store, input: { path: file }, workspaceRoot: workspaceDir });

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
    const ctx = makeCtx({ store, input: { path: file }, workspaceRoot: workspaceDir });

    const hook = createReadSnapshotAfterHook();
    await hook(makeResult({ isError: true, output: "error" }), ctx);

    expect(store.getState().readSnapshots.size).toBe(0);
  });

  test("does not modify the result object", async () => {
    const file = workspaceFile("after-hook-identity.txt");
    const store = createMockStore();
    const ctx = makeCtx({ store, input: { path: file }, workspaceRoot: workspaceDir });
    const result = makeResult({ output: "hello" });

    const hook = createReadSnapshotAfterHook();
    const returned = await hook(result, ctx);

    expect(returned).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// createReadBeforeEditGuard
// ─────────────────────────────────────────────────────────────────────

describe("createReadBeforeEditGuard", () => {
  test("allows edit when path is in snapshots and mtime matches", async () => {
    const file = workspaceFile("edit-allow.txt");
    const realpath = realpathSync.native(file);
    const snapshots = new Map([[realpath, statSync(realpath).mtimeMs]]);
    const store = createMockStore(snapshots);
    const ctx = makeCtx({ store, workspaceRoot: workspaceDir });

    const guard = createReadBeforeEditGuard();
    const decision = await guard({ path: file }, ctx);

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows equivalent normalized path when canonical snapshot exists", async () => {
    const file = workspaceFile("subdir/canonical-edit.txt");
    const realpath = realpathSync.native(file);
    const snapshots = new Map([[realpath, statSync(realpath).mtimeMs]]);
    const store = createMockStore(snapshots);
    const ctx = makeCtx({ store, workspaceRoot: workspaceDir });

    const guard = createReadBeforeEditGuard();
    const decision = await guard({ path: "subdir/../subdir/canonical-edit.txt" }, ctx);

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("denies when path not in snapshots (not read first)", async () => {
    const file = workspaceFile("edit-not-read.txt");
    const store = createMockStore();
    const ctx = makeCtx({ store, workspaceRoot: workspaceDir });

    const guard = createReadBeforeEditGuard();
    const decision = await guard({ path: file }, ctx);

    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("not been read");
  });

  test("denies when mtime changed (write conflict)", async () => {
    const file = workspaceFile("edit-conflict.txt");
    const realpath = realpathSync.native(file);
    const snapshots = new Map([[realpath, 12345]]);
    const store = createMockStore(snapshots);
    const ctx = makeCtx({ store, workspaceRoot: workspaceDir });

    const guard = createReadBeforeEditGuard();
    const decision = await guard({ path: file }, ctx);

    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("modified");
  });

  test("denies with permission-like reason for non-existent snapshots entry", async () => {
    const file = workspaceFile("edit-never-snapshotted.txt");
    const store = createMockStore(new Map());
    const ctx = makeCtx({ store, workspaceRoot: workspaceDir });

    const guard = createReadBeforeEditGuard();
    const decision = await guard({ path: file }, ctx);

    expect(decision.outcome).toBe("deny");
  });
});

// ─────────────────────────────────────────────────────────────────────
// createWorkspaceGuard
// ─────────────────────────────────────────────────────────────────────

describe("createWorkspaceGuard", () => {
  test("allows path inside workspace", async () => {
    const file = workspaceFile("ws-inner.txt");
    const guard = createWorkspaceGuard();
    const decision = await guard({ path: file }, makeCtx({ workspaceRoot: workspaceDir }));

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("denies path outside workspace", async () => {
    const outsideFile = join(testDir, "ws-outside.txt");
    writeFileSync(outsideFile, "content", "utf-8");
    const guard = createWorkspaceGuard();
    const decision = await guard(
      { path: outsideFile },
      makeCtx({ workspaceRoot: workspaceDir }),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("outside workspace");
  });
});

// ─────────────────────────────────────────────────────────────────────
// isSensitiveFile / SENSITIVE_PATTERNS
// ─────────────────────────────────────────────────────────────────────

describe("isSensitiveFile", () => {
  test.each([
    // sensitive
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    ["key.pem", true],
    ["secret.key", true],
    ["cert.p12", true],
    ["id_rsa", true],
    ["id_rsa.pub", true],
    ["id_ed25519", true],
    [".gitconfig", true],
    [".bashrc", true],
    [".zshrc", true],
    [".npmrc", true],
    // NOT sensitive
    ["README.md", false],
    ["index.ts", false],
    ["package.json", false],
    [".gitignore", false],
    ["tsconfig.json", false],
    ["main.go", false],
  ])("isSensitiveFile(%j) returns %j", (filename, expected) => {
    expect(isSensitiveFile(filename)).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────
// createSensitiveFileGuard
// ─────────────────────────────────────────────────────────────────────

describe("createSensitiveFileGuard", () => {
  test("returns ask for .env files", async () => {
    const guard = createSensitiveFileGuard();
    const decision = await guard({ path: "/workspace/.env" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("sensitive");
    expect(decision.prompt).toBeTruthy();
  });

  test("returns ask for .pem files", async () => {
    const guard = createSensitiveFileGuard();
    const decision = await guard({ path: "/workspace/cert.pem" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("sensitive");
  });

  test("returns allow for non-sensitive files", async () => {
    const guard = createSensitiveFileGuard();
    const decision = await guard({ path: "/workspace/index.ts" }, makeCtx());

    expect(decision).toEqual({ outcome: "allow" });
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
    const store = createMockStore(snapshots);

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
    const store = createMockStore(snapshots);

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
    const store = createMockStore(snapshots);

    const file = workspaceFile("lru-new.txt");
    const realpath = realpathSync.native(file);
    const ctx = makeCtx({
      store,
      input: { path: file },
      workspaceRoot: workspaceDir,
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
    const store = createMockStore(snapshots);

    const file = workspaceFile("lru-below.txt");
    const realpath = realpathSync.native(file);
    const ctx = makeCtx({
      store,
      input: { path: file },
      workspaceRoot: workspaceDir,
    });

    const hook = createReadSnapshotAfterHook();
    await hook(makeResult({ output: "content" }), ctx);

    expect(store.getState().readSnapshots.size).toBe(101); // 100 + 1
    expect(store.getState().readSnapshots.has(realpath)).toBe(true);
  });
});
