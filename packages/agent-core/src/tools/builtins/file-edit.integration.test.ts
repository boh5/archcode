import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { setLspClientPoolForTest } from "../../lsp";
import { FakeLspServer, installFakeLspServerPool } from "../../lsp/test-utils";
import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";
import { createTestTempRoot } from "../../testing/test-temp-root";
import { createTestProjectContext } from "../test-project-context";
import { createTestToolRegistryFixture } from "../test-registry";
import { expectSettledResult } from "../test-results";
import type { ToolExecutionContext } from "../types";
import { fileEditTool } from "./file-edit";

const tempRoot = createTestTempRoot("file-edit-integration");
const testDir = path.join(tempRoot.path, "workspace");
const registryFixture = createTestToolRegistryFixture({ descriptors: [fileEditTool] });

beforeEach(async () => {
  await tempRoot.cleanup();
  await mkdir(testDir, { recursive: true });
});

afterEach(() => setLspClientPoolForTest(undefined));
afterAll(async () => {
  await registryFixture.dispose();
  await tempRoot.cleanup();
});

describe("fileEditTool integration", () => {
  test("appends LSP diagnostics after successful registry edit when lsp_diagnostics is allowed", async () => {
    await writeWorkspaceFile("problem.ts", "const value: string = 1;\n");
    const server = new FakeLspServer({ autoDiagnostics: [diagnostic("Type 'number' is not assignable to type 'string'.", "TS2322")] });
    const pool = await installFakeLspServerPool(server, testDir);
    try {
      const result = expectSettledResult(await execute("problem.ts", new Set(["file_edit", "lsp_diagnostics"])));
      expect(result.isError).toBe(false);
      expect(result.output.preview).toContain("Successfully applied 1 edit(s) to problem.ts");
      expect(result.output.preview).toContain("Post-edit diagnostics:");
      expect(result.output.preview).toContain("problem.ts:1:7 error TS2322: Type 'number' is not assignable to type 'string'.");
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
    } finally {
      await server.stop();
    }
  });

  test("does not append LSP diagnostics when post-edit file is clean", async () => {
    await writeWorkspaceFile("clean.ts", "const value = 1;\n");
    const server = new FakeLspServer({ autoDiagnostics: [] });
    await installFakeLspServerPool(server, testDir);
    try {
      const result = expectSettledResult(await execute("clean.ts", new Set(["file_edit", "lsp_diagnostics"])));
      expect(result.output.preview).toBe("Successfully applied 1 edit(s) to clean.ts");
    } finally {
      await server.stop();
    }
  });

  test("skips post-edit diagnostics when lsp_diagnostics is not allowed", async () => {
    await writeWorkspaceFile("not-allowed.ts", "const value: string = 1;\n");
    const server = new FakeLspServer({ autoDiagnostics: [diagnostic("Type error")] });
    const pool = await installFakeLspServerPool(server, testDir);
    try {
      const result = expectSettledResult(await execute("not-allowed.ts", new Set(["file_edit"])));
      expect(result.output.preview).toBe("Successfully applied 1 edit(s) to not-allowed.ts");
      expect(pool.acquireOptions).toEqual([]);
      expect(pool.releaseKeys).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

async function execute(file: string, allowedTools: Set<string>) {
  const filePath = path.join(testDir, file);
  const fileStat = await stat(filePath);
  const store = createMockStore({ readSnapshots: new Map([[realpathSync.native(filePath), fileStat.mtimeMs]]) });
  const context = makeCtx({ store, allowedTools });
  return registryFixture.registry.execute(
    { toolCallId: context.toolCallId, toolName: "file_edit", input: { path: file, edits: [{ oldString: "1", newString: "2" }] } },
    context,
  );
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(testDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}

function diagnostic(message: string, code?: string) {
  return { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, severity: 1, code, message };
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createMockStore(), toolName: "file_edit", toolCallId: "call-1", input: {}, step: 1,
    abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["file_edit"]),
    cwd: testDir, storeManager, projectContext: createTestProjectContext(testDir), ...overrides,
  };
}
