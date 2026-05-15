import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolExecutionContext } from "../types";
import { createWorkspacePermission } from "./workspace";

let testDir: string;
let workspaceDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "ws-perm-test-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "ws-perm-workspace-"));
  mkdirSync(join(workspaceDir, "subdir"), { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    store: {} as ToolExecutionContext["store"],
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

function workspaceFile(name: string): string {
  const p = join(workspaceDir, name);
  writeFileSync(p, "content", "utf-8");
  return p;
}

describe("createWorkspacePermission", () => {
  test("allows path inside workspace", async () => {
    const file = workspaceFile("ws-inner.txt");
    const permission = createWorkspacePermission();
    const decision = await permission({ path: file }, makeCtx({ workspaceRoot: workspaceDir }));

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("asks for path outside workspace with exact file approval scope", async () => {
    const outsideFile = join(testDir, "ws-outside.txt");
    writeFileSync(outsideFile, "content", "utf-8");
    const resolvedOutsideFile = realpathSync(outsideFile);
    const permission = createWorkspacePermission();
    const decision = await permission(
      { path: outsideFile },
      makeCtx({ workspaceRoot: workspaceDir }),
    );

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("outside workspace");
    expect(decision.source).toBe("tool-guard");
    expect(decision.ruleId).toBe("tool-file-outside-workspace");
    expect(decision.approval).toEqual({
      eligible: true,
      scope: {
        kind: "file-path",
        operation: "read",
        path: resolvedOutsideFile,
        pathMode: "exact",
      },
      display: `Access ${resolvedOutsideFile}`,
      reason: "Path is outside workspace",
    });
  });

  test("allows when path is missing from input", async () => {
    const permission = createWorkspacePermission();
    const decision = await permission({ content: "no path" }, makeCtx({ workspaceRoot: workspaceDir }));

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("defaults to checking 'path' key", async () => {
    const outsideFile = join(testDir, "ws-default-key.txt");
    writeFileSync(outsideFile, "content", "utf-8");
    const permission = createWorkspacePermission();
    const decision = await permission(
      { path: outsideFile },
      makeCtx({ workspaceRoot: workspaceDir }),
    );

    expect(decision.outcome).toBe("ask");
    expect(decision.approval?.scope).toMatchObject({
      kind: "file-path",
      operation: "read",
      pathMode: "exact",
    });
  });

  describe("with pathKey option", () => {
    test("checks filePath key when pathKey is 'filePath'", async () => {
      const outsideFile = join(testDir, "ws-filepath-outside.txt");
      writeFileSync(outsideFile, "content", "utf-8");
      const permission = createWorkspacePermission({ pathKey: "filePath" });
      const decision = await permission(
        { filePath: outsideFile, path: workspaceDir },
        makeCtx({ workspaceRoot: workspaceDir }),
      );

      expect(decision.outcome).toBe("ask");
      expect(decision.approval?.scope).toMatchObject({
        kind: "file-path",
        operation: "read",
        pathMode: "exact",
      });
    });

    test("allows safe filePath with pathKey 'filePath'", async () => {
      const file = workspaceFile("ws-filepath-safe.txt");
      const permission = createWorkspacePermission({ pathKey: "filePath" });
      const decision = await permission(
        { filePath: file },
        makeCtx({ workspaceRoot: workspaceDir }),
      );

      expect(decision).toEqual({ outcome: "allow" });
    });

    test("ignores 'path' key when pathKey is 'filePath'", async () => {
      const outsideFile = join(testDir, "ws-filepath-ignore.txt");
      writeFileSync(outsideFile, "content", "utf-8");
      const permission = createWorkspacePermission({ pathKey: "filePath" });
      const decision = await permission(
        { filePath: join(workspaceDir, "safe.txt"), path: outsideFile },
        makeCtx({ workspaceRoot: workspaceDir }),
      );

      expect(decision).toEqual({ outcome: "allow" });
    });
  });
});
