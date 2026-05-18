import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { FakeLspServer } from "../../../lsp/fake-server";
import { LspClient } from "../../../lsp/client";
import { setLspClientPoolForTest, type LspClientPool, type PoolKey } from "../../../lsp/client-pool";
import type { StdioLspTransportOptions } from "../../../lsp/transport";
import { createMockStore } from "../../../store/test-helpers";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult, type FormattedToolError } from "../../errors";
import { ToolRegistry } from "../../registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { lspDiagnosticsTool } from "./lsp-diagnostics";
import { createTestProjectContext } from "../../test-project-context";

const testDir = path.join(import.meta.dir, "__test_tmp__", "lsp-diagnostics");

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

describe("lspDiagnosticsTool", () => {
  test("exports descriptor with correct traits, permissions, and schema", () => {
    expect(lspDiagnosticsTool.name).toBe("lsp_diagnostics");
    expect(lspDiagnosticsTool.traits).toEqual({
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
    });
    expect(lspDiagnosticsTool.permissions).toHaveLength(1);
    expect(lspDiagnosticsTool.inputSchema).toBeDefined();
    expect(lspDiagnosticsTool.inputSchema.safeParse({ filePath: "src/main.ts" }).success).toBe(true);
    expect(lspDiagnosticsTool.inputSchema.safeParse({ filePath: "src/main.ts", extra: true }).success).toBe(false);
  });

  test("returns formatted diagnostics after didOpen", async () => {
    await writeWorkspaceFile("problem.ts", "const value: string = 1;\n");
    const diagnostics = [
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        severity: 1,
        code: "TS2322",
        message: "Type 'number' is not assignable to type 'string'.",
      },
    ];
    const server = new FakeLspServer({ autoDiagnostics: diagnostics });
    const pool = await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute({ filePath: "problem.ts" }, makeCtx());

      expect(result).toBe(
        "Diagnostics: problem.ts:1:7 error TS2322: Type 'number' is not assignable to type 'string'.",
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

  test("returns no diagnostics message for empty publishDiagnostics", async () => {
    await writeWorkspaceFile("clean.ts", "const ok = true;\n");
    const server = new FakeLspServer({ autoDiagnostics: [] });
    await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute({ filePath: "clean.ts" }, makeCtx());

      expect(result).toBe("No diagnostics found.");
    } finally {
      await server.stop();
    }
  });

  test("filters diagnostics by severity", async () => {
    await writeWorkspaceFile("mixed.ts", "const unused = 1;\n");
    const diagnostics = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 1,
        message: "Syntax error",
      },
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
        severity: 2,
        message: "Unused variable",
      },
    ];
    const server = new FakeLspServer({ autoDiagnostics: diagnostics });
    await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute(
        { filePath: "mixed.ts", severity: "warning" },
        makeCtx(),
      );

      expect(result).toBe("Diagnostics: mixed.ts:1:7 warning: Unused variable");
    } finally {
      await server.stop();
    }
  });

  test("returns lsp-timeout error with stale diagnostics on timeout", async () => {
    await writeWorkspaceFile("timeout.ts", "const ok = true;\n");
    setLspClientPoolForTest(new HangingPool() as unknown as LspClientPool);

    const startedAt = Date.now();
    const result = await lspDiagnosticsTool.execute({ filePath: "timeout.ts" }, makeCtx()) as ToolExecutionResult;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_900);
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-timeout");
    expect(result.output).toContain("Diagnostics timed out after 5000ms; showing last known diagnostics.");
    expect(result.output).toContain("No diagnostics found.");
    expect((result.meta?.[TOOL_ERROR_META_KEY] as FormattedToolError).code).toBe("TOOL_LSP_TIMEOUT");
  }, 7_000);

  test("execute returns workspace error for path outside workspace", async () => {
    const result = await lspDiagnosticsTool.execute({ filePath: "../outside.ts" }, makeCtx()) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("outside the workspace");
  });

  test("returns lsp-server-not-found for unsupported extension", async () => {
    await writeWorkspaceFile("notes.unknownext", "hello\n");

    const result = await lspDiagnosticsTool.execute({ filePath: "notes.unknownext" }, makeCtx()) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-server-not-found");
    expect(result.output).toContain("No language mapping found");
  });

  test("returns lsp-server-not-found when no server definition supports the mapped language", async () => {
    await writeWorkspaceFile("notes.md", "# Title\n");

    const result = await lspDiagnosticsTool.execute({ filePath: "notes.md" }, makeCtx()) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("lsp-server-not-found");
    expect((result.meta?.[TOOL_ERROR_META_KEY] as FormattedToolError).message).toContain(
      'No language server is available for language "markdown"',
    );
  });

  test("workspace permission asks for ../ traversal through registry when confirmation is unavailable", async () => {
    const registry = new ToolRegistry();
    registry.register(lspDiagnosticsTool);

    const result = await registry.execute(
      { toolName: "lsp_diagnostics", toolCallId: "call-1", input: { filePath: "../outside.ts" } },
      makeCtx({ toolName: "lsp_diagnostics", toolCallId: "call-1", input: { filePath: "../outside.ts" } }),
    );

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("permission-confirmation-unavailable");
  });

  // ─── Directory support ───

  test("directory collects diagnostics from multiple files", async () => {
    await writeWorkspaceFile("src/a.ts", "const x: number = 'string';\n");
    await writeWorkspaceFile("src/b.ts", "const y: number = true;\n");

    const diagnostic = {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
      severity: 1,
      message: "Type error",
    };
    const server = new FakeLspServer({ autoDiagnostics: [diagnostic] });
    await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute({ filePath: "src" }, makeCtx());

      expect(result).toContain(`${testDir}/src/a.ts:1:7 error: Type error`);
      expect(result).toContain(`${testDir}/src/b.ts:1:7 error: Type error`);
      expect(result).toContain("Diagnostics:");
    } finally {
      await server.stop();
    }
  });

  test("directory skips node_modules, .git, dist, and hidden dirs", async () => {
    await writeWorkspaceFile("src/valid.ts", "const ok = true;\n");
    await writeWorkspaceFile("node_modules/pkg/lib.ts", "const x = 1;\n");
    await writeWorkspaceFile(".git/config.ts", "const cfg = 1;\n");
    await writeWorkspaceFile("dist/out.ts", "const dist = 1;\n");
    await writeWorkspaceFile("build/out.ts", "const build = 1;\n");
    await writeWorkspaceFile("coverage/lcov.ts", "const cov = 1;\n");
    await writeWorkspaceFile(".turbo/turbo.ts", "const t = 1;\n");
    await writeWorkspaceFile(".next/next.ts", "const n = 1;\n");
    await writeWorkspaceFile("__test_tmp__/temp.ts", "const tmp = 1;\n");
    await writeWorkspaceFile(".hidden/secret.ts", "const secret = 1;\n");

    const diagnostic = {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
      severity: 1,
      message: "Error",
    };
    const server = new FakeLspServer({ autoDiagnostics: [diagnostic] });
    await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute({ filePath: testDir }, makeCtx());

      // Only src/valid.ts should be found — the rest are in skipped directories
      expect(result).toContain(`${testDir}/src/valid.ts`);
      expect(result).not.toContain("node_modules/pkg");
      expect(result).not.toContain(".git/config");
      expect(result).not.toContain("dist/out");
      expect(result).not.toContain("build/out");
      expect(result).not.toContain("coverage/lcov");
      expect(result).not.toContain(".turbo/turbo");
      expect(result).not.toContain(".next/next");
      expect(result).not.toContain("__test_tmp__/temp");
      expect(result).not.toContain(".hidden/secret");
    } finally {
      await server.stop();
    }
  });

  test("directory returns workspace error for path outside workspace", async () => {
    const result = await lspDiagnosticsTool.execute(
      { filePath: "../outside-dir" },
      makeCtx(),
    ) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("outside the workspace");
  });

  test("empty directory returns no diagnostics found", async () => {
    await mkdir(path.join(testDir, "empty"), { recursive: true });

    const server = new FakeLspServer({ autoDiagnostics: [] });
    await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute({ filePath: "empty" }, makeCtx());

      expect(result).toBe("No diagnostics found.");
    } finally {
      await server.stop();
    }
  });

  test("directory with no supported language files returns informational message", async () => {
    await writeWorkspaceFile("readme.txt", "hello\n");
    await writeWorkspaceFile("data.csv", "a,b,c\n");

    const server = new FakeLspServer({ autoDiagnostics: [] });
    await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute({ filePath: testDir }, makeCtx());

      expect(result).toBe("No diagnostics found (no supported language files).");
    } finally {
      await server.stop();
    }
  });

  test("directory sorts diagnostics by file path, line, column, severity", async () => {
    await writeWorkspaceFile("b.ts", "const b = 1;\n");
    await writeWorkspaceFile("a.ts", "const a = 2;\n");

    const errorDiag = {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
      severity: 1,
      message: "First error",
    };
    const warningDiag = {
      range: { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } },
      severity: 2,
      message: "First warning",
    };
    const server = new FakeLspServer({ autoDiagnostics: [errorDiag, warningDiag] });
    await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute({ filePath: testDir }, makeCtx()) as string;

      // Sort order: a.ts first (alphabetical), then b.ts
      // Within each file: line 1:7 error, then line 1:9 warning (severity alpha)
      const aErrorIdx = result.indexOf(`${testDir}/a.ts:1:7 error: First error`);
      const aWarningIdx = result.indexOf(`${testDir}/a.ts:1:9 warning: First warning`);
      const bErrorIdx = result.indexOf(`${testDir}/b.ts:1:7 error: First error`);
      const bWarningIdx = result.indexOf(`${testDir}/b.ts:1:9 warning: First warning`);

      expect(aErrorIdx).toBeGreaterThan(-1);
      expect(aWarningIdx).toBeGreaterThan(-1);
      expect(bErrorIdx).toBeGreaterThan(-1);
      expect(bWarningIdx).toBeGreaterThan(-1);

      expect(aErrorIdx).toBeLessThan(aWarningIdx);
      expect(aWarningIdx).toBeLessThan(bErrorIdx);
      expect(bErrorIdx).toBeLessThan(bWarningIdx);
    } finally {
      await server.stop();
    }
  });

  test("directory with no diagnostics returns no diagnostics found", async () => {
    await writeWorkspaceFile("src/clean.ts", "const ok = true;\n");

    const server = new FakeLspServer({ autoDiagnostics: [] });
    await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute({ filePath: "src" }, makeCtx());

      expect(result).toBe("No diagnostics found.");
    } finally {
      await server.stop();
    }
  });

  test("directory truncates at 200 files and adds warning footer", async () => {
    // Create 250 files to trigger truncation
    for (let i = 0; i < 250; i++) {
      await writeWorkspaceFile(`src/file${i}.ts`, "const x = 1;\n");
    }

    const diagnostic = {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
      severity: 1,
      message: "Error",
    };
    const server = new FakeLspServer({ autoDiagnostics: [diagnostic] });
    await installFakeServerPool(server);

    try {
      const result = await lspDiagnosticsTool.execute({ filePath: "src" }, makeCtx()) as string;

      expect(result).toContain("[Directory diagnostics limited to 200 files. 250 total files found.]");
      // Should have 200 diagnostic entries
      expect(result.startsWith("Diagnostics:\n")).toBe(true);
      // Count lines after header
      const lines = result.split("\n").filter((l) => l.includes(":7 error: Error"));
      expect(lines.length).toBe(200);
    } finally {
      await server.stop();
    }
  }, 60_000);
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

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "lsp_diagnostics",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["lsp_diagnostics"]),
    workspaceRoot: testDir,
    projectContext: createTestProjectContext(testDir),
    ...overrides,
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

class HangingPool {
  async acquire(): Promise<LspClient> {
    return new HangingClient() as unknown as LspClient;
  }

  release(): void {}
}

class HangingClient {
  sendNotification(): void {}

  onNotification(): { dispose(): void } {
    return { dispose() {} };
  }
}
