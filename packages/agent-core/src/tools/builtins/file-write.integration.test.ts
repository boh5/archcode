import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { setLspClientPoolForTest } from "../../lsp";
import { FakeLspServer, installFakeLspServerPool } from "../../lsp/test-utils";
import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";
import { createTestTempRoot } from "../../testing/test-temp-root";
import { ToolRegistry } from "../registry";
import { createTestProjectContext } from "../test-project-context";
import type { ToolExecutionContext } from "../types";
import { fileWriteTool } from "./file-write";

const tempRoot = createTestTempRoot("file-write-integration");
const testDir = path.join(tempRoot.path, "workspace");

beforeEach(async () => {
  await tempRoot.cleanup();
  await mkdir(testDir, { recursive: true });
});
afterEach(() => setLspClientPoolForTest(undefined));
afterAll(() => tempRoot.cleanup());

describe("fileWriteTool integration", () => {
  test("appends LSP diagnostics after successful registry write when lsp_diagnostics is allowed", async () => {
    const server = new FakeLspServer({ autoDiagnostics: [{
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, severity: 1,
      code: "TS2322", message: "Type 'number' is not assignable to type 'string'.",
    }] });
    const pool = await installFakeLspServerPool(server, testDir);
    try {
      const context = makeCtx();
      const registry = new ToolRegistry();
      registry.register(fileWriteTool);
      const result = await registry.execute(
        { toolCallId: context.toolCallId, toolName: "file_write", input: { path: "created.ts", content: "const value: string = 1;\n" } },
        context,
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain("File written to created.ts");
      expect(result.output).toContain("Post-edit diagnostics:");
      expect(result.output).toContain("created.ts:1:7 error TS2322: Type 'number' is not assignable to type 'string'.");
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
    } finally {
      await server.stop();
    }
  });
});

function makeCtx(): ToolExecutionContext {
  return {
    store: createMockStore(), toolName: "file_write", toolCallId: "call-1", input: {}, step: 1,
    abort: new AbortController().signal, startedAt: Date.now(),
    allowedTools: new Set(["file_write", "lsp_diagnostics"]), cwd: testDir, storeManager,
    projectContext: createTestProjectContext(testDir),
  };
}
