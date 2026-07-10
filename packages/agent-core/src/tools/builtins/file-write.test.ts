import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { storeManager } from "../../store/store";
import { setLspClientPoolForTest } from "../../lsp";
import { FakeLspServer, installFakeLspServerPool } from "../../lsp/test-utils";
import { existsSync } from "node:fs";
import {
  mkdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path, { join } from "node:path";
import { createMockStore } from "../../store/test-helpers";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import { ToolRegistry } from "../registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { fileWriteTool } from "./file-write";
import { createTestProjectContext } from "../test-project-context";

const testDir = join(import.meta.dir, "__test_tmp__", "file-write");
const canonicalProjectDir = join(import.meta.dir, "__test_tmp__", "file-write-canonical-project");

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "file_write",
  toolCallId: "call-1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["file_write"]),
  cwd: testDir,
  storeManager,
    projectContext: createTestProjectContext(testDir), ...overrides,  };
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<string> {
  const filePath = join(testDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
  return filePath;
}

async function executeThroughRegistry(
  input: { path: string; content: string },
  ctx: ToolExecutionContext = makeCtx(),
) {
  const registry = new ToolRegistry();
  registry.register(fileWriteTool);

  return registry.execute(
    { toolCallId: ctx.toolCallId, toolName: "file_write", input },
    ctx,
  );
}

beforeEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await rm(canonicalProjectDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
  await mkdir(canonicalProjectDir, { recursive: true });
});

afterEach(() => {
  setLspClientPoolForTest(undefined);
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
  await rm(canonicalProjectDir, { recursive: true, force: true });
});

describe("fileWriteTool", () => {
  test("hard-denies an absolute canonical project-state path from a worktree Session", async () => {
    const target = join(canonicalProjectDir, ".archcode", "blocked.json");
    const confirmPermission = mock(async () => "approve_once" as const);

    const result = await executeThroughRegistry(
      { path: target, content: "{}" },
      makeCtx({
        projectContext: createTestProjectContext(canonicalProjectDir),
        confirmPermission,
      }),
    );

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("permission-denied");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toMatchObject({
      code: "PROTECTED_PATH_WRITE_DENIED",
    });
    expect(confirmPermission).not.toHaveBeenCalled();
    expect(existsSync(target)).toBe(false);
  });

  test("successfully creates a new file and writes content", async () => {
    const output = await fileWriteTool.execute(
      { path: "sample.txt", content: "hello\nworld\n" },
      makeCtx(),
    );

    expect(typeof output).not.toBe("string");
    const result = output as ToolExecutionResult;
    expect(result.output).toBe("File written to sample.txt");
    expect(result.isError).toBe(false);
    expect(result.meta?.diffs).toMatchObject({
      version: 1,
      files: [
        {
          path: "sample.txt",
          status: "created",
          additions: 2,
          deletions: 0,
        },
      ],
    });
    const content = await Bun.file(join(testDir, "sample.txt")).text();
    expect(content).toBe("hello\nworld\n");
  });

  test("successful registry result preserves output and includes created diff metadata", async () => {
    const result = await executeThroughRegistry({
      path: "registry-new.txt",
      content: "line one\nline two\n",
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe("File written to registry-new.txt");
    expect(result.meta?.diffs).toMatchObject({
      version: 1,
      files: [{ path: "registry-new.txt", status: "created" }],
    });
  });

  test("appends LSP diagnostics after successful registry write when lsp_diagnostics is allowed", async () => {
    const diagnostics = [
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        severity: 1,
        code: "TS2322",
        message: "Type 'number' is not assignable to type 'string'.",
      },
    ];
    const server = new FakeLspServer({ autoDiagnostics: diagnostics });
    const pool = await installFakeLspServerPool(server, testDir);

    try {
      const result = await executeThroughRegistry(
        {
          path: "created.ts",
          content: "const value: string = 1;\n",
        },
        makeCtx({ allowedTools: new Set(["file_write", "lsp_diagnostics"]) }),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain("File written to created.ts");
      expect(result.output).toContain("Post-edit diagnostics:");
      expect(result.output).toContain(
        "created.ts:1:7 error TS2322: Type 'number' is not assignable to type 'string'.",
      );
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
    } finally {
      await server.stop();
    }
  });

  test("file-exists permission denies existing files", async () => {
    await writeWorkspaceFile("existing.txt", "old");
    const perm = fileWriteTool.permissions?.[1];
    expect(perm).toBeDefined();

    const decision = await perm!(
      { path: "existing.txt", content: "new" },
      makeCtx(),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("already exists");
    expect(decision.errorKind).toBe("file-already-exists");
    expect(decision.errorCode).toBe("TOOL_FILE_ALREADY_EXISTS");
  });

  test("execute returns an error when the file already exists", async () => {
    await writeWorkspaceFile("execute-existing.txt", "old");

    const result = (await fileWriteTool.execute(
      { path: "execute-existing.txt", content: "new" },
      makeCtx(),
    )) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("file-already-exists");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(result.meta?.diffs).toBeUndefined();
    expect(result.output).toContain("already exists");

    const content = await Bun.file(join(testDir, "execute-existing.txt")).text();
    expect(content).toBe("old");
  });

  test("workspace permission asks for paths outside workspace", async () => {
    const perm = fileWriteTool.permissions?.[0];
    expect(perm).toBeDefined();

    const decision = await perm!(
      { path: "../outside.txt", content: "escape" },
      makeCtx(),
    );

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("outside workspace");
    expect(decision.approval?.scope).toMatchObject({ kind: "file-path", operation: "read", pathMode: "exact" });
  });

  test("sensitive file permission asks for .env files", async () => {
    const perm = fileWriteTool.permissions?.[2];
    expect(perm).toBeDefined();

    const decision = await perm!({ path: ".env", content: "SECRET=1" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("sensitive file");
    expect(decision.prompt).toContain("secrets or credentials");
  });

  test("sensitive file permission asks for .pem files", async () => {
    const perm = fileWriteTool.permissions?.[2];
    expect(perm).toBeDefined();

    const decision = await perm!(
      { path: "keys/cert.pem", content: "PRIVATE KEY" },
      makeCtx(),
    );

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("cert.pem");
  });

  test("auto-mkdir creates nested parent directories", async () => {
    const output = await fileWriteTool.execute(
      { path: "nested/deep/file.txt", content: "nested" },
      makeCtx(),
    );

    expect((output as ToolExecutionResult).output).toBe("File written to nested/deep/file.txt");
    const content = await Bun.file(join(testDir, "nested/deep/file.txt")).text();
    expect(content).toBe("nested");
  });

  test("atomic write leaves the final file and no temp files after rename", async () => {
    const output = await fileWriteTool.execute(
      { path: "atomic.txt", content: "atomic content" },
      makeCtx(),
    );

    expect((output as ToolExecutionResult).output).toBe("File written to atomic.txt");
    expect(existsSync(join(testDir, "atomic.txt"))).toBe(true);
    expect(existsSync(join(testDir, `.tmp-${process.pid}-${Date.now()}`))).toBe(false);
    const parentEntries = await Array.fromAsync(
      new Bun.Glob(".tmp-*").scan({ cwd: testDir }),
    );
    expect(parentEntries).toEqual([]);
  });

  test("concurrent writes to different files succeed", async () => {
    const ctx = makeCtx();

    const outputs = await Promise.all([
      fileWriteTool.execute({ path: "parallel-a.txt", content: "a" }, ctx),
      fileWriteTool.execute({ path: "parallel-b.txt", content: "b" }, ctx),
    ]);

    expect(outputs).toEqual([
      expect.objectContaining({ output: "File written to parallel-a.txt", isError: false }),
      expect.objectContaining({ output: "File written to parallel-b.txt", isError: false }),
    ]);
    const contentA = await Bun.file(join(testDir, "parallel-a.txt")).text();
    const contentB = await Bun.file(join(testDir, "parallel-b.txt")).text();
    expect(contentA).toBe("a");
    expect(contentB).toBe("b");
  });

  test("concurrent writes to the same file are serialized", async () => {
    const ctx = makeCtx();

    const results = await Promise.allSettled([
      fileWriteTool.execute({ path: "same.txt", content: "first" }, ctx),
      fileWriteTool.execute({ path: "same.txt", content: "second" }, ctx),
    ]);

    const succeeded = results.filter(
      (r) =>
        r.status === "fulfilled" &&
        typeof r.value === "object" &&
        r.value !== null &&
        "output" in r.value &&
        r.value.output === "File written to same.txt",
    );
    const failed = results.filter(
      (r) =>
        r.status === "fulfilled" &&
        typeof r.value === "object" &&
        r.value !== null &&
        "isError" in r.value &&
        r.value.isError === true &&
        (r.value as ToolExecutionResult).output.includes("already exists"),
    );
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const content = await Bun.file(join(testDir, "same.txt")).text();
    expect(["first", "second"]).toContain(content);
  });

  test("refreshes readSnapshots after successful write", async () => {
    const store = createMockStore();
    const ctx = makeCtx({ store });
    const filePath = join(testDir, "snapshot.txt");

    const output = await fileWriteTool.execute(
      { path: "snapshot.txt", content: "snapshot" },
      ctx,
    );

    expect((output as ToolExecutionResult).output).toBe("File written to snapshot.txt");
    const resolved = await realpath(filePath);
    const fileStat = await stat(filePath);
    expect(store.getState().readSnapshots.get(resolved)).toBe(fileStat.mtimeMs);
  });

  test("registry denies existing files before execute", async () => {
    await writeWorkspaceFile("registry-existing.txt", "old");

    const result = await executeThroughRegistry({
      path: "registry-existing.txt",
      content: "new",
    });

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("file-already-exists");
    expect(result.output).toContain("already exists");
    const content = await Bun.file(join(testDir, "registry-existing.txt")).text();
    expect(content).toBe("old");
  });

  test("validates input schema", () => {
    expect(
      fileWriteTool.inputSchema.safeParse({ path: "ok.txt", content: "ok" }).success,
    ).toBe(true);
    expect(fileWriteTool.inputSchema.safeParse({ path: "ok.txt" }).success).toBe(false);
    expect(
      fileWriteTool.inputSchema.safeParse({ path: "ok.txt", content: "ok", extra: true })
        .success,
    ).toBe(false);
  });
});
