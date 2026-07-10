import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deriveApprovalScope } from "./scopes";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "permission-scopes");
const WORKSPACE = join(TMP_DIR, "workspace");

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("deriveApprovalScope", () => {
  test("derives exact file scope for sensitive reads", () => {
    expect(deriveApprovalScope({
      operation: "read",
      path: ".env",
      cwd: WORKSPACE,
      reason: 'File ".env" is a sensitive file.',
    })).toEqual({
      kind: "file-path",
      operation: "read",
      path: join(WORKSPACE, ".env"),
      pathMode: "exact",
    });
  });

  test("does not treat .env.example as sensitive", () => {
    expect(deriveApprovalScope({
      operation: "read",
      path: ".env.example",
      cwd: WORKSPACE,
    })).toBeUndefined();
  });

  test("derives exact-only path scope for out-of-workspace operations", () => {
    const outsidePath = join(TMP_DIR, "outside.txt");

    for (const operation of ["read", "write", "edit", "delete"] as const) {
      expect(deriveApprovalScope({
        operation,
        path: outsidePath,
        cwd: WORKSPACE,
        reason: `"${outsidePath}" is outside workspace "${WORKSPACE}" [TOOL_FILE_OUTSIDE_WORKSPACE]`,
      })).toEqual({
        kind: "file-path",
        operation,
        path: outsidePath,
        pathMode: "exact",
      });
    }
  });

  test("does not create subtree approvals outside workspace in v1", () => {
    const scope = deriveApprovalScope({
      operation: "read",
      path: join(TMP_DIR, "outside-dir", "child.txt"),
      cwd: WORKSPACE,
      reason: "outside workspace",
    });

    expect(scope).toMatchObject({ kind: "file-path", pathMode: "exact" });
    expect(scope).not.toMatchObject({ pathMode: "subtree" });
  });

  test("returns no scope for ordinary in-workspace file operations", () => {
    expect(deriveApprovalScope({
      operation: "write",
      path: "src/main.ts",
      cwd: WORKSPACE,
      reason: "file exists",
    })).toBeUndefined();
  });
});
