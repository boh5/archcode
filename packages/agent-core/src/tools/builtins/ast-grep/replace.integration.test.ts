import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { BinaryManager, setBinaryManagerForTest } from "../../../binary/manager";
import { setLspClientPoolForTest } from "../../../lsp";
import { FakeLspServer, installFakeLspServerPool } from "../../../lsp/test-utils";
import { setProcessRunnerForTest } from "../../../process/runner";
import { SkillService } from "../../../skills";
import { storeManager } from "../../../store/store";
import { createMockStore } from "../../../store/test-helpers";
import { createTestTempRoot } from "../../../testing/test-temp-root";
import { createTestProjectContext } from "../../test-project-context";
import { createTestToolRegistryFixture } from "../../test-registry";
import { expectSettledResult } from "../../test-results";
import type { ToolExecutionContext } from "../../types";
import { astGrepReplaceTool } from "./replace";

const tempRoot = createTestTempRoot("ast-grep-replace-integration");
const workspace = join(tempRoot.path, "workspace");
const registryFixture = createTestToolRegistryFixture({ descriptors: [astGrepReplaceTool] });

beforeEach(async () => {
  await tempRoot.cleanup();
  await mkdir(workspace, { recursive: true });
  setBinaryManagerForTest(new BinaryManager({
    which: mock(() => "/managed/bin/ast-grep"),
    exists: mock(() => false),
    isExecutable: mock(() => false),
    download: mock(() => Promise.reject(new Error("download should not run"))),
    verifySha256: mock(() => false),
    install: mock(() => Promise.reject(new Error("install should not run"))),
    validateBinary: mock(() => Promise.resolve(true)),
  }));
});
afterEach(() => {
  setBinaryManagerForTest(undefined);
  setProcessRunnerForTest(undefined);
  setLspClientPoolForTest(undefined);
});
afterAll(async () => {
  await registryFixture.dispose();
  await tempRoot.cleanup();
});

describe("ast_grep_replace tool integration", () => {
  test("apply mode appends LSP diagnostics after successful registry replacement when lsp_diagnostics is allowed", async () => {
    const file = join(workspace, "success.ts");
    writeFileSync(file, "console.log(message)", "utf-8");
    const server = new FakeLspServer({ autoDiagnostics: [{
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, severity: 1,
      code: "TS2322", message: "Type 'number' is not assignable to type 'string'.",
    }] });
    const pool = await installFakeLspServerPool(server, workspace);
    setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]]) => {
      if (cmd.includes("--update-all")) writeFileSync(file, "logger.info(message)", "utf-8");
      return spawnResult(replacementJsonFor("success.ts"));
    }));

    try {
      const context = makeCtx(file);
      const result = expectSettledResult(await registryFixture.registry.execute(
        { toolCallId: context.toolCallId, toolName: "ast_grep_replace", input: { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false } },
        context,
      ));
      expect(result.isError).toBe(false);
      expect(result.output.preview).toContain('"file":"success.ts"');
      expect(result.output.preview).toContain("Post-edit diagnostics:");
      expect(result.output.preview).toContain("success.ts:1:7 error TS2322: Type 'number' is not assignable to type 'string'.");
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: workspace, serverId: "typescript" }]);
    } finally {
      await server.stop();
    }
  });
});

function makeCtx(file: string): ToolExecutionContext {
  const resolved = realpathSync.native(file);
  return {
    store: createMockStore({ readSnapshots: new Map([[resolved, statSync(resolved).mtimeMs]]) }),
    toolName: "ast_grep_replace", toolCallId: "call-id", input: {}, step: 1,
    abort: new AbortController().signal, agentName: "lead-agent", startedAt: Date.now(),
    allowedTools: new Set(["ast_grep_replace", "lsp_diagnostics"]), agentSkills: [],
    skillService: new SkillService({ builtinSkills: {} }), cwd: workspace, storeManager,
    projectContext: createTestProjectContext(workspace),
  };
}

function stream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close(); } });
}

function spawnResult(stdout: string) {
  return { stdout: stream(stdout), stderr: stream(""), exited: Promise.resolve(0), exitCode: 0, signalCode: undefined, kill: mock(() => undefined) };
}

function replacementJsonFor(file: string): string {
  return `${JSON.stringify({ text: "console.log(message)", range: { byteOffset: { start: 0, end: 20 }, start: { line: 0, column: 0 }, end: { line: 0, column: 20 } }, file, lines: "console.log(message)", replacement: "logger.info(message)", replacementOffsets: { start: 0, end: 20 } })}\n`;
}
