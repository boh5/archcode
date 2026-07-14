import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";

import { LspClient, setLspClientPoolForTest, type LspClientPool, type PoolKey } from "../../../lsp";
import type { StdioLspTransportOptions } from "../../../lsp";
import { FakeLspServer } from "../../../lsp/test-utils";
import { storeManager } from "../../../store/store";
import { createMockStore } from "../../../store/test-helpers";
import type { ToolExecutionContext } from "../../types";
import { createTestProjectContext } from "../../test-project-context";
import { lspDiagnosticsTool } from "./lsp-diagnostics";

const testRoot = path.join(import.meta.dir, "__test_tmp__", `lsp-diagnostics-integration-${crypto.randomUUID()}`);
const testDir = path.join(testRoot, "workspace");
const canonicalProjectDir = path.join(testRoot, "project");

beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await Promise.all([
    mkdir(testDir, { recursive: true }),
    mkdir(canonicalProjectDir, { recursive: true }),
  ]);
});

afterEach(() => {
  setLspClientPoolForTest(undefined);
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("lspDiagnosticsTool integration", () => {
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
      expect(result.startsWith("Diagnostics:\n")).toBe(true);
      const lines = result.split("\n").filter((line) => line.includes(":7 error: Error"));
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

function makeCtx(): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "lsp_diagnostics",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["lsp_diagnostics"]),
    cwd: testDir,
    storeManager,
    projectContext: createTestProjectContext(canonicalProjectDir),
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
