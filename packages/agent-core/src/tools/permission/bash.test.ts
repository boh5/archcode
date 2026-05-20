import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockStore } from "../../store/test-helpers";
import type { ToolExecutionContext } from "../types";
import { createBashPermission } from "./bash";
import { createTestProjectContext } from "../test-project-context";

let testDir: string;
let workspaceDir: string;

beforeAll(() => {
  testDir = join(tmpdir(), `bash-permission-${Date.now()}`);
  workspaceDir = join(testDir, "workspace");
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  writeFileSync(join(workspaceDir, "src", "main.ts"), "export {};\n", "utf8");
  writeFileSync(join(workspaceDir, "file"), "needle\n", "utf8");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeCtx(workspaceRoot = workspaceDir): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "bash",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["bash"]),
    workspaceRoot,
    projectContext: createTestProjectContext(workspaceRoot),
  };
}

describe("createBashPermission", () => {
  test("classifies input.command with context workspace root", async () => {
    const permission = createBashPermission();
    const decision = await permission({ command: "cat src/main.ts" }, makeCtx());

    expect(decision.outcome).toBe("allow");
  });

  test("asks for invalid permission input", async () => {
    const permission = createBashPermission();
    const decision = await permission({ value: "pwd" }, makeCtx());

    expect(decision.outcome).toBe("ask");
  });

  test("denies dangerous commands", async () => {
    const permission = createBashPermission();
    const decision = await permission({ command: "rm -rf /" }, makeCtx());

    expect(decision.outcome).toBe("deny");
  });

  test("uses the context workspaceRoot exclusively", async () => {
    const permission = createBashPermission();
    const ctx = makeCtx();
    const decision = await permission({ command: "pwd" }, ctx);

    expect(decision.outcome).toBe("allow");
  });
});
