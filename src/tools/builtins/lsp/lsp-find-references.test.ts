import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { FakeLspServer } from "../../../lsp/fake-server";
import { LspClient } from "../../../lsp/client";
import { setLspClientPoolForTest, type LspClientPool, type PoolKey } from "../../../lsp/client-pool";
import { pathToFileUri } from "../../../lsp/uri-utils";
import type { StdioLspTransportOptions } from "../../../lsp/transport";
import { createMockStore } from "../../../store/test-helpers";
import { inferToolErrorKindFromResult } from "../../errors";
import { ToolRegistry } from "../../registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { lspFindReferencesTool } from "./lsp-find-references";

const testDir = path.join(import.meta.dir, "__test_tmp__", "lsp-find-references");

beforeEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
});

afterEach(() => {
  setLspClientPoolForTest(undefined);
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("lspFindReferencesTool", () => {
  test("exports descriptor with correct traits, permissions, and schema", () => {
    expect(lspFindReferencesTool.name).toBe("lsp_find_references");
    expect(lspFindReferencesTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(lspFindReferencesTool.permissions).toHaveLength(1);
    expect(lspFindReferencesTool.inputSchema).toBeDefined();
    expect(lspFindReferencesTool.inputSchema.safeParse({ filePath: "src/main.ts", line: 1, character: 0 }).success).toBe(true);
    expect(lspFindReferencesTool.inputSchema.safeParse({ filePath: "src/main.ts", line: 1, character: 0, extra: true }).success).toBe(false);
  });

  test("returns multiple references sorted by file path, line, then column", async () => {
    await writeWorkspaceFile("b.ts", "export const value = 1;\nvalue;\n");
    await writeWorkspaceFile("a.ts", "import { value } from './b';\nvalue;\n");
    const responses = {
      "textDocument/references": [
        location("b.ts", 1, 4),
        location("a.ts", 1, 9),
        location("a.ts", 1, 2),
      ],
    };
    const server = new FakeLspServer({ responses });
    const pool = await installFakeServerPool(server);

    try {
      const result = await lspFindReferencesTool.execute(
        { filePath: "b.ts", line: 1, character: 13 },
        makeCtx(),
      );

      expect(result).toBe(`References: ${testDir}/a.ts:2:3, ${testDir}/a.ts:2:10, ${testDir}/b.ts:2:5`);
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
      expect(pool.acquireOptions[0]).toMatchObject({
        command: "typescript-language-server",
        args: ["--stdio"],
        cwd: testDir,
      });
    } finally {
      await server.stop();
    }
  });

  test("defaults includeDeclaration to true", async () => {
    await writeWorkspaceFile("main.ts", "const value = 1;\nvalue;\n");
    const server = new FakeLspServer({ responses: { "textDocument/references": [location("main.ts", 0, 6)] } });
    const pool = await installFakeServerPool(server);

    try {
      await lspFindReferencesTool.execute({ filePath: "main.ts", line: 1, character: 6 }, makeCtx());

      expect(pool.client.requests[0]?.params).toMatchObject({
        context: { includeDeclaration: true },
      });
    } finally {
      await server.stop();
    }
  });

  test("passes includeDeclaration false", async () => {
    await writeWorkspaceFile("main.ts", "const value = 1;\nvalue;\n");
    const server = new FakeLspServer({ responses: { "textDocument/references": [location("main.ts", 1, 0)] } });
    const pool = await installFakeServerPool(server);

    try {
      await lspFindReferencesTool.execute(
        { filePath: "main.ts", line: 1, character: 6, includeDeclaration: false },
        makeCtx(),
      );

      expect(pool.client.requests[0]?.params).toMatchObject({
        context: { includeDeclaration: false },
      });
    } finally {
      await server.stop();
    }
  });

  test("returns no references message for null response", async () => {
    await writeWorkspaceFile("main.ts", "const value = 1;\n");
    const server = new FakeLspServer({ responses: { "textDocument/references": null } });
    await installFakeServerPool(server);

    try {
      const result = await lspFindReferencesTool.execute({ filePath: "main.ts", line: 1, character: 6 }, makeCtx());

      expect(result).toBe("No references found.");
    } finally {
      await server.stop();
    }
  });

  test("converts input position to LSP 0-based and output to 1-based", async () => {
    await writeWorkspaceFile("main.ts", "first\nsecond value\nthird value\n");
    const server = new FakeLspServer({ responses: { "textDocument/references": [location("main.ts", 2, 6)] } });
    const pool = await installFakeServerPool(server);

    try {
      const result = await lspFindReferencesTool.execute(
        { filePath: "main.ts", line: 2, character: 7 },
        makeCtx(),
      );

      expect(pool.client.requests[0]?.params).toMatchObject({
        position: { line: 1, character: 7 },
      });
      expect(result).toBe(`References: ${testDir}/main.ts:3:7`);
    } finally {
      await server.stop();
    }
  });

  test("workspace permission asks for ../ traversal through registry when confirmation is unavailable", async () => {
    const registry = new ToolRegistry();
    registry.register(lspFindReferencesTool);

    const result = await registry.execute(
      { toolName: "lsp_find_references", toolCallId: "call-1", input: { filePath: "../outside.ts", line: 1, character: 0 } },
      makeCtx({ toolName: "lsp_find_references", toolCallId: "call-1", input: { filePath: "../outside.ts", line: 1, character: 0 } }),
    );

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("permission-confirmation-unavailable");
  });

  test("execute returns workspace error for path outside workspace", async () => {
    const result = await lspFindReferencesTool.execute(
      { filePath: "../outside.ts", line: 1, character: 0 },
      makeCtx(),
    ) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("outside the workspace");
  });

  test("returns lsp-server-not-found for unsupported extension", async () => {
    await writeWorkspaceFile("notes.unknownext", "hello\n");

    const result = await lspFindReferencesTool.execute(
      { filePath: "notes.unknownext", line: 1, character: 0 },
      makeCtx(),
    ) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-server-not-found");
    expect(result.output).toContain("No language mapping found");
  });
});

async function installFakeServerPool(server: FakeLspServer): Promise<RecordingPool> {
  const transport = await server.start();
  const client = new LspClient({ transport, workspaceRoot: testDir });
  await client.initialize(testDir);
  const recordingClient = new RecordingClient(client);
  const pool = new RecordingPool(recordingClient);
  setLspClientPoolForTest(pool as unknown as LspClientPool);
  return pool;
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(testDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}

function location(relativePath: string, line: number, character: number) {
  return {
    uri: pathToFileUri(path.join(testDir, relativePath)),
    range: {
      start: { line, character },
      end: { line, character: character + 1 },
    },
  };
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "lsp_find_references",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["lsp_find_references"]),
    workspaceRoot: testDir,
    ...overrides,
  };
}

class RecordingClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];

  constructor(private readonly client: LspClient) {}

  sendNotification(method: string, params?: unknown): void {
    this.client.sendNotification(method, params);
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.client.sendRequest(method, params);
  }
}

class RecordingPool {
  readonly acquireOptions: StdioLspTransportOptions[] = [];
  readonly releaseKeys: PoolKey[] = [];

  constructor(readonly client: RecordingClient) {}

  async acquire(_key: PoolKey, serverOptions: StdioLspTransportOptions): Promise<LspClient> {
    this.acquireOptions.push(serverOptions);
    return this.client as unknown as LspClient;
  }

  release(key: PoolKey): void {
    this.releaseKeys.push(key);
  }
}
