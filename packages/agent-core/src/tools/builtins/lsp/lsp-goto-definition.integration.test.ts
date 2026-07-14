import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

import { LspClient, pathToFileUri, setLspClientPoolForTest, type LspClientPool, type PoolKey, type StdioLspTransportOptions } from "../../../lsp";
import { FakeLspServer } from "../../../lsp/test-utils";
import { storeManager } from "../../../store/store";
import { createMockStore } from "../../../store/test-helpers";
import { createTestTempRoot } from "../../../testing/test-temp-root";
import { createTestProjectContext } from "../../test-project-context";
import type { ToolExecutionContext } from "../../types";
import { lspGotoDefinitionTool } from "./lsp-goto-definition";

const tempRoot = createTestTempRoot("lsp-goto-definition-integration");
const testDir = path.join(tempRoot.path, "workspace");

beforeEach(async () => { await tempRoot.cleanup(); await mkdir(testDir, { recursive: true }); });
afterEach(() => setLspClientPoolForTest(undefined));
afterAll(() => tempRoot.cleanup());

describe("lspGotoDefinitionTool integration", () => {
  test("returns a single formatted definition location", async () => {
    await writeFile("source.ts", "callTarget();\n"); await writeFile("target.ts", "export function callTarget() {}\n");
    const server = new FakeLspServer({ responses: { "textDocument/definition": location("target.ts", 0, 16) } });
    const pool = await install(server);
    try {
      expect(await execute()).toBe(`Definition: ${testDir}/target.ts:1:17`);
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
      expect(pool.acquireOptions[0]).toMatchObject({ command: "typescript-language-server", args: ["--stdio"], cwd: testDir });
    } finally { await server.stop(); }
  });

  test("returns multiple formatted definition locations", async () => {
    await writeFile("source.ts", "callTarget();\n"); await writeFile("a.ts", "export const a = 1;\n"); await writeFile("b.ts", "export const b = 2;\n");
    const server = new FakeLspServer({ responses: { "textDocument/definition": [location("a.ts", 1, 3), location("b.ts", 4, 8)] } });
    await install(server);
    try { expect(await execute()).toBe(`Definition: ${testDir}/a.ts:2:4\n${testDir}/b.ts:5:9`); } finally { await server.stop(); }
  });

  test("handles LocationLink responses using target range", async () => {
    await writeFile("source.ts", "callTarget();\n"); await writeFile("linked.ts", "export function linked() {}\n");
    const range = { start: { line: 2, character: 5 }, end: { line: 2, character: 11 } };
    const server = new FakeLspServer({ responses: { "textDocument/definition": [{ originSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, targetUri: pathToFileUri(path.join(testDir, "linked.ts")), targetRange: range, targetSelectionRange: range }] } });
    await install(server);
    try { expect(await execute()).toBe(`Definition: ${testDir}/linked.ts:3:6`); } finally { await server.stop(); }
  });

  test("returns no definitions message for null response", async () => {
    await writeFile("source.ts", "const value = 1;\n");
    const server = new FakeLspServer({ responses: { "textDocument/definition": null } }); await install(server);
    try { expect(await execute()).toBe("No definitions found."); } finally { await server.stop(); }
  });

  test("converts input position to zero-based LSP position", async () => {
    await writeFile("source.ts", "first\nsecond\n");
    const server = new FakeLspServer({ responses: { "textDocument/definition": location("source.ts", 0, 0) } }); const pool = await install(server);
    try {
      await lspGotoDefinitionTool.execute({ filePath: "source.ts", line: 2, character: 4 }, makeCtx());
      expect(pool.client.requests).toEqual([{ method: "textDocument/definition", params: { textDocument: { uri: pathToFileUri(path.join(realpathSync.native(testDir), "source.ts")) }, position: { line: 1, character: 4 } } }]);
    } finally { await server.stop(); }
  });
});

async function execute() { return lspGotoDefinitionTool.execute({ filePath: "source.ts", line: 1, character: 2 }, makeCtx()); }
async function install(server: FakeLspServer): Promise<RecordingPool> { const transport = await server.start(); const client = new RecordingClient({ transport, workspaceRoot: testDir }); await client.initialize(testDir); const pool = new RecordingPool(client); setLspClientPoolForTest(pool as unknown as LspClientPool); return pool; }
class RecordingClient extends LspClient { readonly requests: { method: string; params?: unknown }[] = []; override async sendRequest(method: string, params?: unknown): Promise<unknown> { if (method === "textDocument/definition") this.requests.push({ method, params }); return super.sendRequest(method, params); } }
class RecordingPool { readonly acquireOptions: StdioLspTransportOptions[] = []; readonly releaseKeys: PoolKey[] = []; constructor(readonly client: RecordingClient) {} async acquire(_key: PoolKey, options: StdioLspTransportOptions): Promise<LspClient> { this.acquireOptions.push(options); return this.client; } release(key: PoolKey): void { this.releaseKeys.push(key); } }
async function writeFile(relativePath: string, content: string): Promise<void> { const filePath = path.join(testDir, relativePath); await mkdir(path.dirname(filePath), { recursive: true }); await Bun.write(filePath, content); }
function location(relativePath: string, line: number, character: number) { return { uri: pathToFileUri(path.join(testDir, relativePath)), range: { start: { line, character }, end: { line, character: character + 1 } } }; }
function makeCtx(): ToolExecutionContext { return { store: createMockStore(), toolName: "lsp_goto_definition", toolCallId: "call-1", input: {}, step: 1, abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["lsp_goto_definition"]), cwd: testDir, storeManager, projectContext: createTestProjectContext(testDir) }; }
