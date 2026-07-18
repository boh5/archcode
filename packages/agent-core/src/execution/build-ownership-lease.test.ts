import { describe, expect, test } from "bun:test";

import {
  BuildOwnershipConflictError,
  BuildOwnershipLeaseRegistry,
} from "./build-ownership-lease";

describe("BuildOwnershipLeaseRegistry", () => {
  test("rejects exact file overlap in one execution cwd", () => {
    const registry = new BuildOwnershipLeaseRegistry();
    registry.acquire({
      workspaceRoot: "/workspace",
      executionCwd: "/workspace",
      sessionId: "build-a",
      ownedScope: [{ kind: "file", path: "src/app.ts" }],
    });

    expect(() => registry.acquire({
      workspaceRoot: "/workspace",
      executionCwd: "/workspace",
      sessionId: "build-b",
      ownedScope: [{ kind: "file", path: "src/app.ts" }],
    })).toThrow(BuildOwnershipConflictError);
  });

  test("rejects tree ancestor overlap in either direction", () => {
    const registry = new BuildOwnershipLeaseRegistry();
    registry.acquire({
      workspaceRoot: "/workspace",
      executionCwd: "/workspace",
      sessionId: "build-a",
      ownedScope: [{ kind: "tree", path: "src/features" }],
    });

    for (const ownedScope of [
      [{ kind: "file" as const, path: "src/features/panel.ts" }],
      [{ kind: "tree" as const, path: "src" }],
      [{ kind: "tree" as const, path: "src/features/panel" }],
    ]) {
      expect(() => registry.acquire({
        workspaceRoot: "/workspace",
        executionCwd: "/workspace",
        sessionId: crypto.randomUUID(),
        ownedScope,
      })).toThrow(BuildOwnershipConflictError);
    }
  });

  test("allows sibling files, sibling trees, and the same scope in another cwd", () => {
    const registry = new BuildOwnershipLeaseRegistry();
    registry.acquire({
      workspaceRoot: "/workspace",
      executionCwd: "/workspace",
      sessionId: "build-a",
      ownedScope: [
        { kind: "file", path: "src/a.ts" },
        { kind: "tree", path: "src/feature-a" },
      ],
    });

    expect(() => registry.acquire({
      workspaceRoot: "/workspace",
      executionCwd: "/workspace",
      sessionId: "build-b",
      ownedScope: [
        { kind: "file", path: "src/b.ts" },
        { kind: "tree", path: "src/feature-b" },
      ],
    })).not.toThrow();
    expect(() => registry.acquire({
      workspaceRoot: "/workspace",
      executionCwd: "/workspace/.archcode/worktrees/goal-a",
      sessionId: "build-c",
      ownedScope: [{ kind: "file", path: "src/a.ts" }],
    })).not.toThrow();
  });

  test("release is idempotent and makes the exact scope available", () => {
    const registry = new BuildOwnershipLeaseRegistry();
    const lease = registry.acquire({
      workspaceRoot: "/workspace",
      executionCwd: "/workspace",
      sessionId: "build-a",
      ownedScope: [{ kind: "tree", path: "src" }],
    });

    lease.release();
    lease.release();

    expect(() => registry.acquire({
      workspaceRoot: "/workspace",
      executionCwd: "/workspace",
      sessionId: "build-b",
      ownedScope: [{ kind: "file", path: "src/app.ts" }],
    })).not.toThrow();
  });
});
