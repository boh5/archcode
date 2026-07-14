import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

import { pathToFileUri, setLspClientPoolForTest } from "../../../lsp";
import { FakeLspServer, installFakeLspServerPool } from "../../../lsp/test-utils";
import { storeManager } from "../../../store/store";
import { createMockStore } from "../../../store/test-helpers";
import { createTestTempRoot } from "../../../testing/test-temp-root";
import { createTestProjectContext } from "../../test-project-context";
import type { ToolExecutionContext } from "../../types";
import { lspSymbolsTool } from "./lsp-symbols";

const tempRoot = createTestTempRoot("lsp-symbols-integration");
const testDir = path.join(tempRoot.path, "workspace");

beforeEach(async () => { await tempRoot.cleanup(); await mkdir(testDir, { recursive: true }); });
afterEach(() => setLspClientPoolForTest(undefined));
afterAll(() => tempRoot.cleanup());

describe("lspSymbolsTool integration", () => {
  test("document scope returns hierarchical symbols after didOpen", async () => {
    await writeFile("example.ts", "class Greeter { greet() {} }\n");
    const server = new FakeLspServer({ responses: { "textDocument/documentSymbol": [{ name: "Greeter", kind: 5, range: range(0, 0), selectionRange: range(0, 6), children: [{ name: "greet", kind: 6, range: range(0, 16), selectionRange: range(0, 16) }] }] } });
    const pool = await installFakeLspServerPool(server, testDir);
    try {
      const realFile = path.join(realpathSync.native(testDir), "example.ts");
      expect(await lspSymbolsTool.execute({ scope: "document", filePath: "example.ts" }, makeCtx())).toBe(`Symbols: Class Greeter (${realFile}:1:1), Method greet (${realFile}:1:17)`);
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
      expect(pool.acquireOptions[0]).toMatchObject({ command: "typescript-language-server", args: ["--stdio"], cwd: testDir });
    } finally { await server.stop(); }
  });

  test("document scope returns flat SymbolInformation symbols", async () => {
    await writeFile("flat.ts", "function makeThing() {}\n"); const absoluteFile = path.join(testDir, "flat.ts");
    const server = new FakeLspServer({ responses: { "textDocument/documentSymbol": [{ name: "makeThing", kind: 12, location: { uri: pathToFileUri(absoluteFile), range: range(0, 9) } }] } });
    await installFakeLspServerPool(server, testDir);
    try { expect(await lspSymbolsTool.execute({ scope: "document", filePath: "flat.ts" }, makeCtx())).toBe(`Symbols: Function makeThing (${absoluteFile}:1:10)`); } finally { await server.stop(); }
  });

  test("workspace scope returns matching symbols for query", async () => {
    const absoluteFile = path.join(testDir, "workspace.ts");
    const server = new FakeLspServer({ responses: { "workspaceSymbol/symbol": [{ name: "WorkspaceThing", kind: 5, location: { uri: pathToFileUri(absoluteFile), range: range(2, 4) } }] } });
    const pool = await installFakeLspServerPool(server, testDir);
    try {
      expect(await lspSymbolsTool.execute({ scope: "workspace", query: "Thing" }, makeCtx())).toBe(`Symbols: Class WorkspaceThing (${absoluteFile}:3:5)`);
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
    } finally { await server.stop(); }
  });

  test("returns no symbols found for empty and null responses", async () => {
    await writeFile("empty.ts", "const ok = true;\n");
    const documentServer = new FakeLspServer({ responses: { "textDocument/documentSymbol": [] } }); await installFakeLspServerPool(documentServer, testDir);
    try { expect(await lspSymbolsTool.execute({ scope: "document", filePath: "empty.ts" }, makeCtx())).toBe("No symbols found."); } finally { await documentServer.stop(); }
    const workspaceServer = new FakeLspServer({ responses: { "workspaceSymbol/symbol": null } }); await installFakeLspServerPool(workspaceServer, testDir);
    try { expect(await lspSymbolsTool.execute({ scope: "workspace", query: "missing" }, makeCtx())).toBe("No symbols found."); } finally { await workspaceServer.stop(); }
  });
});

async function writeFile(relativePath: string, content: string): Promise<void> { const filePath = path.join(testDir, relativePath); await mkdir(path.dirname(filePath), { recursive: true }); await Bun.write(filePath, content); }
function range(line: number, character: number) { return { start: { line, character }, end: { line, character: character + 1 } }; }
function makeCtx(): ToolExecutionContext { return { store: createMockStore(), toolName: "lsp_symbols", toolCallId: "call-1", input: {}, step: 1, abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["lsp_symbols"]), cwd: testDir, storeManager, projectContext: createTestProjectContext(testDir) }; }
