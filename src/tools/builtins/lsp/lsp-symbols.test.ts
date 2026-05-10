import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { StoreApi } from "zustand";
import { FakeLspServer } from "../../../lsp/fake-server";
import { LspClient } from "../../../lsp/client";
import { setLspClientPoolForTest, type LspClientPool, type PoolKey } from "../../../lsp/client-pool";
import { pathToFileUri } from "../../../lsp/uri-utils";
import type { StdioLspTransportOptions } from "../../../lsp/transport";
import type { SessionStoreState } from "../../../store/index";
import { inferToolErrorKindFromResult } from "../../errors";
import { ToolRegistry } from "../../registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { lspSymbolsTool } from "./lsp-symbols";

const testDir = path.join(import.meta.dir, "__test_tmp__", "lsp-symbols");

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

describe("lspSymbolsTool", () => {
  test("exports descriptor with correct traits, guards, and schema", () => {
    expect(lspSymbolsTool.name).toBe("lsp_symbols");
    expect(lspSymbolsTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(lspSymbolsTool.guards).toHaveLength(1);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "document", filePath: "src/main.ts" }).success).toBe(true);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "workspace", query: "main" }).success).toBe(true);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "document" }).success).toBe(false);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "workspace" }).success).toBe(false);
    expect(lspSymbolsTool.inputSchema.safeParse({ scope: "workspace", query: "main", extra: true }).success).toBe(false);
  });

  test("document scope returns hierarchical symbols after didOpen", async () => {
    await writeWorkspaceFile("example.ts", "class Greeter { greet() {} }\n");
    const server = new FakeLspServer({
      responses: {
        "textDocument/documentSymbol": [
          {
            name: "Greeter",
            kind: 5,
            range: range(0, 0),
            selectionRange: range(0, 6),
            children: [
              {
                name: "greet",
                kind: 6,
                range: range(0, 16),
                selectionRange: range(0, 16),
              },
            ],
          },
        ],
      },
    });
    const pool = await installFakeServerPool(server);

    try {
      const result = await lspSymbolsTool.execute({ scope: "document", filePath: "example.ts" }, makeCtx());

      expect(result).toBe(
        `Symbols: Class Greeter (${path.join(testDir, "example.ts")}:1:1), Method greet (${path.join(testDir, "example.ts")}:1:17)`,
      );
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

  test("document scope returns flat SymbolInformation symbols", async () => {
    await writeWorkspaceFile("flat.ts", "function makeThing() {}\n");
    const absoluteFile = path.join(testDir, "flat.ts");
    const server = new FakeLspServer({
      responses: {
        "textDocument/documentSymbol": [
          {
            name: "makeThing",
            kind: 12,
            location: {
              uri: pathToFileUri(absoluteFile),
              range: range(0, 9),
            },
          },
        ],
      },
    });
    await installFakeServerPool(server);

    try {
      const result = await lspSymbolsTool.execute({ scope: "document", filePath: "flat.ts" }, makeCtx());

      expect(result).toBe(`Symbols: Function makeThing (${absoluteFile}:1:10)`);
    } finally {
      await server.stop();
    }
  });

  test("workspace scope returns matching symbols for query", async () => {
    const absoluteFile = path.join(testDir, "workspace.ts");
    const server = new FakeLspServer({
      responses: {
        "workspaceSymbol/symbol": [
          {
            name: "WorkspaceThing",
            kind: 5,
            location: {
              uri: pathToFileUri(absoluteFile),
              range: range(2, 4),
            },
          },
        ],
      },
    });
    const pool = await installFakeServerPool(server);

    try {
      const result = await lspSymbolsTool.execute({ scope: "workspace", query: "Thing" }, makeCtx());

      expect(result).toBe(`Symbols: Class WorkspaceThing (${absoluteFile}:3:5)`);
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
    } finally {
      await server.stop();
    }
  });

  test("returns no symbols found for empty and null responses", async () => {
    await writeWorkspaceFile("empty.ts", "const ok = true;\n");
    const documentServer = new FakeLspServer({ responses: { "textDocument/documentSymbol": [] } });
    await installFakeServerPool(documentServer);

    try {
      const documentResult = await lspSymbolsTool.execute({ scope: "document", filePath: "empty.ts" }, makeCtx());
      expect(documentResult).toBe("No symbols found.");
    } finally {
      await documentServer.stop();
    }

    const workspaceServer = new FakeLspServer({ responses: { "workspaceSymbol/symbol": null } });
    await installFakeServerPool(workspaceServer);

    try {
      const workspaceResult = await lspSymbolsTool.execute({ scope: "workspace", query: "missing" }, makeCtx());
      expect(workspaceResult).toBe("No symbols found.");
    } finally {
      await workspaceServer.stop();
    }
  });

  test("schema rejects document scope without filePath", () => {
    const parsed = lspSymbolsTool.inputSchema.safeParse({ scope: "document" });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("filePath is required when scope is 'document'");
    }
  });

  test("schema rejects workspace scope without query", () => {
    const parsed = lspSymbolsTool.inputSchema.safeParse({ scope: "workspace" });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe("query is required when scope is 'workspace'");
    }
  });

  test("workspace guard blocks document path outside workspace through registry", async () => {
    const registry = new ToolRegistry();
    registry.register(lspSymbolsTool);

    const input = { scope: "document", filePath: "../outside.ts" };
    const result = await registry.execute(
      { toolName: "lsp_symbols", toolCallId: "call-1", input },
      makeCtx({ toolName: "lsp_symbols", toolCallId: "call-1", input }),
    );

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.meta?.permissionErrorCode).toBe("TOOL_FILE_OUTSIDE_WORKSPACE");
  });

  test("execute returns workspace error for document path outside workspace", async () => {
    const result = await lspSymbolsTool.execute(
      { scope: "document", filePath: "../outside.ts" },
      makeCtx(),
    ) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("outside the workspace");
  });
});

async function installFakeServerPool(server: FakeLspServer): Promise<RecordingPool> {
  const transport = await server.start();
  const client = new LspClient({ transport, workspaceRoot: testDir });
  await client.initialize(testDir);
  const pool = new RecordingPool(client);
  setLspClientPoolForTest(pool as unknown as LspClientPool);
  return pool;
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(testDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}

function range(line: number, character: number) {
  return {
    start: { line, character },
    end: { line, character: character + 1 },
  };
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "lsp_symbols",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["lsp_symbols"]),
    workspaceRoot: testDir,
    ...overrides,
  };
}

function createMockStore(): StoreApi<SessionStoreState> {
  const state: SessionStoreState = {
    sessionId: "test",
    createdAt: Date.now(),
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionIds: new Set(),
    subAgentDescriptions: new Map(),
    isRunning: false,
    isStreamingModel: false,
    streamingTools: {},
    readSnapshots: new Map(),
    runCount: 0,
    append: () => {},
    toModelMessages: () => [],
  };

  return {
    getState: () => state,
    getInitialState: () => state,
    setState: (partial) => {
      if (typeof partial === "function") {
        Object.assign(state, partial(state));
        return;
      }
      Object.assign(state, partial);
    },
    subscribe: () => () => {},
  };
}

class RecordingPool {
  readonly acquireOptions: StdioLspTransportOptions[] = [];
  readonly releaseKeys: PoolKey[] = [];

  constructor(private readonly client: LspClient) {}

  async acquire(_key: PoolKey, serverOptions: StdioLspTransportOptions): Promise<LspClient> {
    this.acquireOptions.push(serverOptions);
    return this.client;
  }

  release(key: PoolKey): void {
    this.releaseKeys.push(key);
  }
}
