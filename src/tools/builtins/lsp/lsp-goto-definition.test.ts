import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { LspClient } from "../../../lsp/client";
import { setLspClientPoolForTest, type LspClientPool, type PoolKey } from "../../../lsp/client-pool";
import { FakeLspServer } from "../../../lsp/fake-server";
import { pathToFileUri } from "../../../lsp/uri-utils";
import type { StdioLspTransportOptions } from "../../../lsp/transport";
import { createMockStore } from "../../../store/test-helpers";
import { inferToolErrorKindFromResult } from "../../errors";
import { ToolRegistry } from "../../registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { lspGotoDefinitionTool } from "./lsp-goto-definition";

const testDir = path.join(import.meta.dir, "__test_tmp__", "lsp-goto-definition");

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

describe("lspGotoDefinitionTool", () => {
  test("exports descriptor with correct traits, guards, and schema", () => {
    expect(lspGotoDefinitionTool.name).toBe("lsp_goto_definition");
    expect(lspGotoDefinitionTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(lspGotoDefinitionTool.guards).toHaveLength(1);
    expect(lspGotoDefinitionTool.inputSchema.safeParse({ filePath: "src/main.ts", line: 1, character: 0 }).success).toBe(true);
    expect(lspGotoDefinitionTool.inputSchema.safeParse({ filePath: "src/main.ts", line: 1, character: 0, extra: true }).success).toBe(false);
  });

  test("returns a single formatted definition location", async () => {
    await writeWorkspaceFile("source.ts", "callTarget();\n");
    await writeWorkspaceFile("target.ts", "export function callTarget() {}\n");
    const server = new FakeLspServer({
      responses: {
        "textDocument/definition": {
          uri: pathToFileUri(path.join(testDir, "target.ts")),
          range: { start: { line: 0, character: 16 }, end: { line: 0, character: 26 } },
        },
      },
    });
    const pool = await installFakeServerPool(server);

    try {
      const result = await lspGotoDefinitionTool.execute({ filePath: "source.ts", line: 1, character: 2 }, makeCtx());

      expect(result).toBe(`Definition: ${testDir}/target.ts:1:17`);
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

  test("returns multiple formatted definition locations", async () => {
    await writeWorkspaceFile("source.ts", "callTarget();\n");
    await writeWorkspaceFile("a.ts", "export const a = 1;\n");
    await writeWorkspaceFile("b.ts", "export const b = 2;\n");
    const server = new FakeLspServer({
      responses: {
        "textDocument/definition": [
          {
            uri: pathToFileUri(path.join(testDir, "a.ts")),
            range: { start: { line: 1, character: 3 }, end: { line: 1, character: 4 } },
          },
          {
            uri: pathToFileUri(path.join(testDir, "b.ts")),
            range: { start: { line: 4, character: 8 }, end: { line: 4, character: 9 } },
          },
        ],
      },
    });
    await installFakeServerPool(server);

    try {
      const result = await lspGotoDefinitionTool.execute({ filePath: "source.ts", line: 1, character: 2 }, makeCtx());

      expect(result).toBe(`Definition: ${testDir}/a.ts:2:4\n${testDir}/b.ts:5:9`);
    } finally {
      await server.stop();
    }
  });

  test("handles LocationLink responses using target range", async () => {
    await writeWorkspaceFile("source.ts", "callTarget();\n");
    await writeWorkspaceFile("linked.ts", "export function linked() {}\n");
    const server = new FakeLspServer({
      responses: {
        "textDocument/definition": [
          {
            originSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
            targetUri: pathToFileUri(path.join(testDir, "linked.ts")),
            targetRange: { start: { line: 2, character: 5 }, end: { line: 2, character: 11 } },
            targetSelectionRange: { start: { line: 2, character: 5 }, end: { line: 2, character: 11 } },
          },
        ],
      },
    });
    await installFakeServerPool(server);

    try {
      const result = await lspGotoDefinitionTool.execute({ filePath: "source.ts", line: 1, character: 2 }, makeCtx());

      expect(result).toBe(`Definition: ${testDir}/linked.ts:3:6`);
    } finally {
      await server.stop();
    }
  });

  test("returns no definitions message for null response", async () => {
    await writeWorkspaceFile("source.ts", "const value = 1;\n");
    const server = new FakeLspServer({ responses: { "textDocument/definition": null } });
    await installFakeServerPool(server);

    try {
      const result = await lspGotoDefinitionTool.execute({ filePath: "source.ts", line: 1, character: 2 }, makeCtx());

      expect(result).toBe("No definitions found.");
    } finally {
      await server.stop();
    }
  });

  test("converts input position to zero-based LSP position", async () => {
    await writeWorkspaceFile("source.ts", "first\nsecond\n");
    const server = new FakeLspServer({
      responses: {
        "textDocument/definition": {
          uri: pathToFileUri(path.join(testDir, "source.ts")),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      },
    });
    const pool = await installFakeServerPool(server);

    try {
      await lspGotoDefinitionTool.execute({ filePath: "source.ts", line: 2, character: 4 }, makeCtx());

      expect(pool.client.requests).toEqual([
        {
          method: "textDocument/definition",
          params: {
            textDocument: { uri: pathToFileUri(path.join(testDir, "source.ts")) },
            position: { line: 1, character: 4 },
          },
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  test("execute returns workspace error for path outside workspace", async () => {
    const result = await lspGotoDefinitionTool.execute({ filePath: "../outside.ts", line: 1, character: 0 }, makeCtx()) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("outside the workspace");
  });

  test("workspace guard blocks traversal through registry", async () => {
    const registry = new ToolRegistry();
    registry.register(lspGotoDefinitionTool);

    const result = await registry.execute(
      { toolName: "lsp_goto_definition", toolCallId: "call-1", input: { filePath: "../outside.ts", line: 1, character: 0 } },
      makeCtx({ toolName: "lsp_goto_definition", toolCallId: "call-1", input: { filePath: "../outside.ts", line: 1, character: 0 } }),
    );

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.meta?.permissionErrorCode).toBe("TOOL_FILE_OUTSIDE_WORKSPACE");
  });

  test("returns lsp-server-not-found for unsupported extension", async () => {
    await writeWorkspaceFile("notes.unknownext", "hello\n");

    const result = await lspGotoDefinitionTool.execute({ filePath: "notes.unknownext", line: 1, character: 0 }, makeCtx()) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-server-not-found");
    expect(result.output).toContain("No language mapping found");
  });
});

async function installFakeServerPool(server: FakeLspServer): Promise<RecordingPool> {
  const transport = await server.start();
  const client = new RecordingClient({ transport, workspaceRoot: testDir });
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

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "lsp_goto_definition",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["lsp_goto_definition"]),
    workspaceRoot: testDir,
    ...overrides,
  };
}

class RecordingClient extends LspClient {
  readonly requests: { method: string; params?: unknown }[] = [];

  override async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (method === "textDocument/definition") {
      this.requests.push({ method, params });
    }
    return super.sendRequest(method, params);
  }
}

class RecordingPool {
  readonly acquireOptions: StdioLspTransportOptions[] = [];
  readonly releaseKeys: PoolKey[] = [];

  constructor(readonly client: RecordingClient) {}

  async acquire(_key: PoolKey, serverOptions: StdioLspTransportOptions): Promise<LspClient> {
    this.acquireOptions.push(serverOptions);
    return this.client;
  }

  release(key: PoolKey): void {
    this.releaseKeys.push(key);
  }
}
