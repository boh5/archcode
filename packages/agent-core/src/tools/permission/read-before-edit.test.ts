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
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/index";
import { createMockStore } from "../../store/test-helpers";
import type { ToolExecutionContext } from "../types";
import { createReadBeforeEditPermission } from "./read-before-edit";
import { createTestProjectContext } from "../test-project-context";

let workspaceDir: string;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "rbe-perm-workspace-"));
  mkdirSync(join(workspaceDir, "subdir"), { recursive: true });
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "file_edit",
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

function workspaceFile(name: string): string {
  const p = join(workspaceDir, name);
  writeFileSync(p, "content", "utf-8");
  return p;
}

describe("createReadBeforeEditPermission", () => {
  test("allows edit when path is in snapshots and mtime matches", async () => {
    const file = workspaceFile("edit-allow.txt");
    const realpath = realpathSync.native(file);
    const snapshots = new Map([[realpath, statSync(realpath).mtimeMs]]);
    const store = createMockStore({ readSnapshots: snapshots });
    const ctx = makeCtx({ store, cwd: workspaceDir });

    const permission = createReadBeforeEditPermission();
    const decision = await permission({ path: file }, ctx);

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("allows equivalent normalized path when canonical snapshot exists", async () => {
    const file = workspaceFile("subdir/canonical-edit.txt");
    const realpath = realpathSync.native(file);
    const snapshots = new Map([[realpath, statSync(realpath).mtimeMs]]);
    const store = createMockStore({ readSnapshots: snapshots });
    const ctx = makeCtx({ store, cwd: workspaceDir });

    const permission = createReadBeforeEditPermission();
    const decision = await permission({ path: "subdir/../subdir/canonical-edit.txt" }, ctx);

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("denies when path not in snapshots (not read first)", async () => {
    const file = workspaceFile("edit-not-read.txt");
    const store = createMockStore();
    const ctx = makeCtx({ store, cwd: workspaceDir });

    const permission = createReadBeforeEditPermission();
    const decision = await permission({ path: file }, ctx);

    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("not been read");
  });

  test("denies when mtime changed (write conflict)", async () => {
    const file = workspaceFile("edit-conflict.txt");
    const realpath = realpathSync.native(file);
    const snapshots = new Map([[realpath, 12345]]);
    const store = createMockStore({ readSnapshots: snapshots });
    const ctx = makeCtx({ store, cwd: workspaceDir });

    const permission = createReadBeforeEditPermission();
    const decision = await permission({ path: file }, ctx);

    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("modified");
  });

  test("denies with permission-like reason for non-existent snapshots entry", async () => {
    const file = workspaceFile("edit-never-snapshotted.txt");
    const store = createMockStore();
    const ctx = makeCtx({ store, cwd: workspaceDir });

    const permission = createReadBeforeEditPermission();
    const decision = await permission({ path: file }, ctx);

    expect(decision.outcome).toBe("deny");
  });
});
