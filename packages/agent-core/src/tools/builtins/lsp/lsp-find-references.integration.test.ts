import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { LspClient, pathToFileUri, setLspClientPoolForTest, type LspClientPool, type PoolKey, type StdioLspTransportOptions } from "../../../lsp";
import { FakeLspServer } from "../../../lsp/test-utils";
import { storeManager } from "../../../store/store";
import { createMockStore } from "../../../store/test-helpers";
import { createTestTempRoot } from "../../../testing/test-temp-root";
import { createTestProjectContext } from "../../test-project-context";
import type { ToolExecutionContext } from "../../types";
import { lspFindReferencesTool } from "./lsp-find-references";

const tempRoot = createTestTempRoot("lsp-find-references-integration");
const testDir = path.join(tempRoot.path, "workspace");

beforeEach(async () => {
  await tempRoot.cleanup();
  await mkdir(testDir, { recursive: true });
});
afterEach(() => setLspClientPoolForTest(undefined));
afterAll(() => tempRoot.cleanup());

describe("lspFindReferencesTool integration", () => {
  test("returns multiple references sorted by file path, line, then column", async () => {
    await writeWorkspaceFile("b.ts", "export const value = 1;\nvalue;\n");
    await writeWorkspaceFile("a.ts", "import { value } from './b';\nvalue;\n");
    const server = new FakeLspServer({ responses: { "textDocument/references": [location("b.ts", 1, 4), location("a.ts", 1, 9), location("a.ts", 1, 2)] } });
    const pool = await install(server);
    try {
      const result = await lspFindReferencesTool.execute({ filePath: "b.ts", line: 1, character: 13 }, makeCtx());
      expect(result).toBe(`References: ${testDir}/a.ts:2:3, ${testDir}/a.ts:2:10, ${testDir}/b.ts:2:5`);
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
      expect(pool.acquireOptions[0]).toMatchObject({ command: "typescript-language-server", args: ["--stdio"], cwd: testDir });
    } finally { await server.stop(); }
  });

  test("defaults includeDeclaration to true", async () => {
    await writeWorkspaceFile("main.ts", "const value = 1;\nvalue;\n");
    const server = new FakeLspServer({ responses: { "textDocument/references": [location("main.ts", 0, 6)] } });
    const pool = await install(server);
    try {
      await lspFindReferencesTool.execute({ filePath: "main.ts", line: 1, character: 6 }, makeCtx());
      expect(pool.client.requests[0]?.params).toMatchObject({ context: { includeDeclaration: true } });
    } finally { await server.stop(); }
  });

  test("passes includeDeclaration false", async () => {
    await writeWorkspaceFile("main.ts", "const value = 1;\nvalue;\n");
    const server = new FakeLspServer({ responses: { "textDocument/references": [location("main.ts", 1, 0)] } });
    const pool = await install(server);
    try {
      await lspFindReferencesTool.execute({ filePath: "main.ts", line: 1, character: 6, includeDeclaration: false }, makeCtx());
      expect(pool.client.requests[0]?.params).toMatchObject({ context: { includeDeclaration: false } });
    } finally { await server.stop(); }
  });

  test("returns no references message for null response", async () => {
    await writeWorkspaceFile("main.ts", "const value = 1;\n");
    const server = new FakeLspServer({ responses: { "textDocument/references": null } });
    await install(server);
    try {
      expect(await lspFindReferencesTool.execute({ filePath: "main.ts", line: 1, character: 6 }, makeCtx())).toBe("No references found.");
    } finally { await server.stop(); }
  });

  test("converts input position to LSP 0-based and output to 1-based", async () => {
    await writeWorkspaceFile("main.ts", "first\nsecond value\nthird value\n");
    const server = new FakeLspServer({ responses: { "textDocument/references": [location("main.ts", 2, 6)] } });
    const pool = await install(server);
    try {
      const result = await lspFindReferencesTool.execute({ filePath: "main.ts", line: 2, character: 7 }, makeCtx());
      expect(pool.client.requests[0]?.params).toMatchObject({ position: { line: 1, character: 7 } });
      expect(result).toBe(`References: ${testDir}/main.ts:3:7`);
    } finally { await server.stop(); }
  });
});

async function install(server: FakeLspServer): Promise<RecordingPool> {
  const transport = await server.start();
  const client = new RecordingClient(new LspClient({ transport, workspaceRoot: testDir }));
  await client.initialize(testDir);
  const pool = new RecordingPool(client);
  setLspClientPoolForTest(pool as unknown as LspClientPool);
  return pool;
}

class RecordingClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly client: LspClient) {}
  initialize(root: string) { return this.client.initialize(root); }
  sendNotification(method: string, params?: unknown): void { this.client.sendNotification(method, params); }
  async sendRequest(method: string, params?: unknown): Promise<unknown> { this.requests.push({ method, params }); return this.client.sendRequest(method, params); }
  openTextDocument(options: Parameters<LspClient["openTextDocument"]>[0]): ReturnType<LspClient["openTextDocument"]> { return this.client.openTextDocument(options); }
}

class RecordingPool {
  readonly acquireOptions: StdioLspTransportOptions[] = [];
  readonly releaseKeys: PoolKey[] = [];
  constructor(readonly client: RecordingClient) {}
  async acquire(_key: PoolKey, options: StdioLspTransportOptions): Promise<LspClient> { this.acquireOptions.push(options); return this.client as unknown as LspClient; }
  release(key: PoolKey): void { this.releaseKeys.push(key); }
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(testDir, relativePath); await mkdir(path.dirname(filePath), { recursive: true }); await Bun.write(filePath, content);
}
function location(relativePath: string, line: number, character: number) { return { uri: pathToFileUri(path.join(testDir, relativePath)), range: { start: { line, character }, end: { line, character: character + 1 } } }; }
function makeCtx(): ToolExecutionContext { return { store: createMockStore(), toolName: "lsp_find_references", toolCallId: "call-1", input: {}, step: 1, abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["lsp_find_references"]), cwd: testDir, storeManager, projectContext: createTestProjectContext(testDir) }; }
