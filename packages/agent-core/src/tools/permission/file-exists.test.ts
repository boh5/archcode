import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { storeManager } from "../../store/store";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolExecutionContext } from "../types";
import { createFileExistsPermission } from "./file-exists";
import { createTestProjectContext } from "../test-project-context";

let workspaceDir: string;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "fe-perm-workspace-"));
  mkdirSync(join(workspaceDir, "subdir"), { recursive: true });
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeCtx(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return { store: {} as ToolExecutionContext["store"],
  toolName: "file_write",
  toolCallId: "call-1",
  input: {},
  step: 0,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set<string>(),
  cwd: workspaceDir,
  storeManager,
    projectContext: createTestProjectContext(workspaceDir), ...overrides,  };
}

function workspaceFile(name: string): string {
  const p = join(workspaceDir, name);
  writeFileSync(p, "content", "utf-8");
  return p;
}

describe("createFileExistsPermission", () => {
  test("denies when target file already exists", async () => {
    const file = workspaceFile("existing.txt");
    const permission = createFileExistsPermission();
    const decision = await permission({ path: file }, makeCtx());

    expect(decision.outcome).toBe("deny");
    expect(decision.errorCode).toBe("TOOL_FILE_ALREADY_EXISTS");
    expect(decision.errorKind).toBe("file-already-exists");
    expect(decision.reason).toContain("already exists");
  });

  test("allows when target file does not exist", async () => {
    const permission = createFileExistsPermission();
    const decision = await permission(
      { path: join(workspaceDir, "nonexistent.txt") },
      makeCtx(),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });
});
