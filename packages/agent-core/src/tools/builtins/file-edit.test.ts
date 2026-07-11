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
import { realpathSync, statSync } from "node:fs";
import {
  mkdir,
  rm,
  stat,
  symlink,
  utimes,
} from "node:fs/promises";
import path, { join } from "node:path";
import type { StoreApi } from "zustand";
import { setLspClientPoolForTest } from "../../lsp";
import { FakeLspServer, installFakeLspServerPool } from "../../lsp/test-utils";
import type { SessionStoreState } from "../../store/index";
import { createMockStore } from "../../store/test-helpers";
import { inferToolErrorKindFromResult, TOOL_ERROR_META_KEY } from "../errors";
import { createReadSnapshotAfterHook } from "../hooks";
import { ToolRegistry } from "../registry";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { fileEditTool } from "./file-edit";
import { createTestProjectContext } from "../test-project-context";

const testDir = join(import.meta.dir, "__test_tmp__", "file-edit");
const canonicalProjectDir = join(import.meta.dir, "__test_tmp__", "file-edit-canonical-project");

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "file_edit",
  toolCallId: "call-1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["file_edit"]),
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

async function createReadStore(filePath: string): Promise<StoreApi<SessionStoreState>> {
  const resolved = realpathSync.native(filePath);
  const fileStat = await stat(filePath);
  return createMockStore({ readSnapshots: new Map([[resolved, fileStat.mtimeMs]]) });
}

async function makeReadCtx(relativePath: string): Promise<ToolExecutionContext> {
  const filePath = join(testDir, relativePath);
  return makeCtx({ store: await createReadStore(filePath) });
}

async function executeThroughRegistry(
  input: unknown,
  ctx: ToolExecutionContext,
) {
  const registry = new ToolRegistry();
  registry.register(fileEditTool);

  return registry.execute(
    { toolCallId: ctx.toolCallId, toolName: "file_edit", input },
    ctx,
  );
}

function expectToolErrorKind(
  result: ToolExecutionResult,
  kind: NonNullable<ReturnType<typeof inferToolErrorKindFromResult>>,
): void {
  expect(result.isError).toBe(true);
  expect(inferToolErrorKindFromResult(result)).toBe(kind);
  expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
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

describe("fileEditTool", () => {
  test("hard-denies canonical project state through a worktree symlink", async () => {
    const canonicalState = join(canonicalProjectDir, ".archcode");
    const target = join(canonicalState, "blocked.txt");
    const stateLink = join(testDir, "canonical-state");
    await mkdir(canonicalState, { recursive: true });
    await Bun.write(target, "before\n");
    await symlink(canonicalState, stateLink);
    const confirmPermission = mock(async () => "approve_once" as const);

    const result = await executeThroughRegistry(
      {
        path: join(stateLink, "blocked.txt"),
        edits: [{ oldString: "before", newString: "after" }],
      },
      makeCtx({
        projectContext: createTestProjectContext(canonicalProjectDir),
        store: await createReadStore(target),
        confirmPermission,
      }),
    );

    expectToolErrorKind(result, "permission-denied");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toMatchObject({
      code: "PROTECTED_PATH_WRITE_DENIED",
    });
    expect(confirmPermission).not.toHaveBeenCalled();
    expect(await Bun.file(target).text()).toBe("before\n");
  });

  test("successfully applies a single edit", async () => {
    await writeWorkspaceFile("single.txt", "hello world\n");
    const ctx = await makeReadCtx("single.txt");

    const output = await fileEditTool.execute(
      { path: "single.txt", edits: [{ oldString: "world", newString: "archcode" }] },
      ctx,
    );

    expect(typeof output).not.toBe("string");
    const result = output as ToolExecutionResult;
    expect(result.output).toBe("Successfully applied 1 edit(s) to single.txt");
    expect(result.isError).toBe(false);
    expect(result.meta?.diffs).toMatchObject({
      version: 1,
      files: [
        {
          path: "single.txt",
          status: "modified",
          additions: 1,
          deletions: 1,
        },
      ],
    });
    expect(await Bun.file(join(testDir, "single.txt")).text()).toBe("hello archcode\n");
  });

  test("successfully applies multiple edits", async () => {
    await writeWorkspaceFile("multiple.txt", "alpha beta gamma\n");
    const ctx = await makeReadCtx("multiple.txt");

    const output = await fileEditTool.execute(
      {
        path: "multiple.txt",
        edits: [
          { oldString: "alpha", newString: "one" },
          { oldString: "gamma", newString: "three" },
        ],
      },
      ctx,
    );

    expect((output as ToolExecutionResult).output).toBe("Successfully applied 2 edit(s) to multiple.txt");
    expect(await Bun.file(join(testDir, "multiple.txt")).text()).toBe(
      "one beta three\n",
    );
  });

  test("rejects the removed flat edit input", async () => {
    await writeWorkspaceFile("flat-input.txt", "before\n");
    const ctx = await makeReadCtx("flat-input.txt");

    const result = await executeThroughRegistry(
      { path: "flat-input.txt", oldString: "before", newString: "after" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Invalid input");
    expect(await Bun.file(join(testDir, "flat-input.txt")).text()).toBe("before\n");
  });

  test("prepareInput normalizes smart punctuation in oldString", async () => {
    await writeWorkspaceFile("quotes.ts", 'const label = "hello";\n');
    const ctx = await makeReadCtx("quotes.ts");
    let resolvedInput: unknown;

    const result = await executeThroughRegistry(
      {
        path: "quotes.ts",
        edits: [
          {
            oldString: "const label = “hello”;",
            newString: 'const label = "bye";',
          },
        ],
      },
      makeCtx({
        store: ctx.store,
        onInputResolved(input) {
          resolvedInput = input;
        },
      }),
    );

    expect(result.isError).toBe(false);
    expect(resolvedInput).toEqual({
      path: "quotes.ts",
      edits: [
        {
          oldString: 'const label = "hello";',
          newString: 'const label = "bye";',
        },
      ],
    });
    expect(await Bun.file(join(testDir, "quotes.ts")).text()).toBe('const label = "bye";\n');
  });

  test("returns error when oldString is not found", async () => {
    await writeWorkspaceFile("missing.txt", "actual content\n");
    const ctx = await makeReadCtx("missing.txt");

    const result = await executeThroughRegistry(
      { path: "missing.txt", edits: [{ oldString: "needle", newString: "value" }] },
      ctx,
    );

    expectToolErrorKind(result, "edit-no-match");
    expect(result.meta?.diffs).toBeUndefined();
    expect(result.output).toContain("TOOL_EDIT_NO_MATCH");
  });

  test("returns error when oldString matches multiple locations", async () => {
    await writeWorkspaceFile("ambiguous.txt", "repeat\nrepeat\n");
    const ctx = await makeReadCtx("ambiguous.txt");

    const result = await executeThroughRegistry(
      { path: "ambiguous.txt", edits: [{ oldString: "repeat", newString: "once" }] },
      ctx,
    );

    expectToolErrorKind(result, "edit-ambiguous");
    expect(result.output).toContain("TOOL_EDIT_AMBIGUOUS_MATCH");
  });

  test("returns error for overlapping edits", async () => {
    await writeWorkspaceFile("overlap.txt", "abcdef\n");
    const ctx = await makeReadCtx("overlap.txt");

    const result = await executeThroughRegistry(
      {
        path: "overlap.txt",
        edits: [
          { oldString: "abc", newString: "123" },
          { oldString: "bcd", newString: "234" },
        ],
      },
      ctx,
    );

    expectToolErrorKind(result, "edit-overlap");
    expect(result.output).toContain("TOOL_EDIT_OVERLAP");
  });

  test("returns error when oldString and newString are identical", async () => {
    await writeWorkspaceFile("identical.txt", "same\n");
    const ctx = await makeReadCtx("identical.txt");

    const result = await executeThroughRegistry(
      { path: "identical.txt", edits: [{ oldString: "same", newString: "same" }] },
      ctx,
    );

    expectToolErrorKind(result, "edit-identical");
    expect(result.output).toContain("oldString and newString are identical");
  });

  test("returns file-not-found error when target file is missing", async () => {
    await writeWorkspaceFile("missing-file.txt", "before\n");
    const store = await createReadStore(join(testDir, "missing-file.txt"));
    await rm(join(testDir, "missing-file.txt"), { force: true });

    const result = await fileEditTool.execute(
      {
        path: "missing-file.txt",
        edits: [{ oldString: "before", newString: "after" }],
      },
      makeCtx({ store }),
    );

    expect(typeof result).not.toBe("string");
    const errorResult = result as ToolExecutionResult;
    expectToolErrorKind(errorResult, "file-not-found");
    expect(errorResult.output).toContain("TOOL_FILE_NOT_FOUND");
  });

  test("fuzzy match handles whitespace, smart quotes, dashes, and line endings", async () => {
    await writeWorkspaceFile(
      "fuzzy.txt",
      "const text = “hello”—world;   \r\nnext line\r\n",
    );
    const ctx = await makeReadCtx("fuzzy.txt");

    const output = await fileEditTool.execute(
      {
        path: "fuzzy.txt",
        edits: [
          {
            oldString: 'const text = "hello"-world;\nnext line',
            newString: "const text = 'updated';\nnext line",
          },
        ],
      },
      ctx,
    );

    expect((output as ToolExecutionResult).output).toBe("Successfully applied 1 edit(s) to fuzzy.txt");
    expect(await Bun.file(join(testDir, "fuzzy.txt")).text()).toBe(
      "const text = 'updated';\nnext line\r\n",
    );
  });

  test("read-before-edit permission denies when file was not read", async () => {
    await writeWorkspaceFile("not-read.txt", "content");
    const ctx = makeCtx();

    const result = await executeThroughRegistry(
      { path: "not-read.txt", edits: [{ oldString: "content", newString: "updated" }] },
      ctx,
    );

    expectToolErrorKind(result, "read-before-write");
    expect(result.output).toContain("not been read first");
  });

  test("appends LSP diagnostics after successful registry edit when lsp_diagnostics is allowed", async () => {
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
    const pool = await installFakeLspServerPool(server, testDir);
    const ctx = await makeReadCtx("problem.ts");

    try {
      const result = await executeThroughRegistry(
        { path: "problem.ts", edits: [{ oldString: "1", newString: "2" }] },
        makeCtx({
          store: ctx.store,
          allowedTools: new Set(["file_edit", "lsp_diagnostics"]),
        }),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Successfully applied 1 edit(s) to problem.ts");
      expect(result.output).toContain("Post-edit diagnostics:");
      expect(result.output).toContain(
        "problem.ts:1:7 error TS2322: Type 'number' is not assignable to type 'string'.",
      );
      expect(pool.releaseKeys).toEqual([{ workspaceRoot: testDir, serverId: "typescript" }]);
    } finally {
      await server.stop();
    }
  });

  test("does not append LSP diagnostics when post-edit file is clean", async () => {
    await writeWorkspaceFile("clean.ts", "const value = 1;\n");
    const server = new FakeLspServer({ autoDiagnostics: [] });
    const ctx = await makeReadCtx("clean.ts");

    try {
      await installFakeLspServerPool(server, testDir);
      const result = await executeThroughRegistry(
        { path: "clean.ts", edits: [{ oldString: "1", newString: "2" }] },
        makeCtx({
          store: ctx.store,
          allowedTools: new Set(["file_edit", "lsp_diagnostics"]),
        }),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toBe("Successfully applied 1 edit(s) to clean.ts");
      expect(result.meta?.postEditDiagnostics).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  test("skips post-edit diagnostics when lsp_diagnostics is not allowed", async () => {
    await writeWorkspaceFile("not-allowed.ts", "const value: string = 1;\n");
    const server = new FakeLspServer({
      autoDiagnostics: [
        {
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          severity: 1,
          message: "Type error",
        },
      ],
    });
    const ctx = await makeReadCtx("not-allowed.ts");

    try {
      const pool = await installFakeLspServerPool(server, testDir);
      const result = await executeThroughRegistry(
        { path: "not-allowed.ts", edits: [{ oldString: "1", newString: "2" }] },
        makeCtx({ store: ctx.store }),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toBe("Successfully applied 1 edit(s) to not-allowed.ts");
      expect(result.meta?.postEditDiagnostics).toBeUndefined();
      expect(pool.acquireOptions).toEqual([]);
      expect(pool.releaseKeys).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test("file_read equivalent normalized path snapshot allows file_edit direct path", async () => {
    const filePath = await writeWorkspaceFile("src/main.ts", "before\n");
    const resolved = realpathSync.native(filePath);
    const store = createMockStore();
    const readCtx = makeCtx({ store, toolName: "file_read", input: { path: "src/../src/main.ts" } });

    await createReadSnapshotAfterHook()({ output: "1: before\n", isError: false }, readCtx);

    expect(store.getState().readSnapshots.has(resolved)).toBe(true);

    const result = await executeThroughRegistry(
      { path: "src/main.ts", edits: [{ oldString: "before", newString: "after" }] },
      makeCtx({ store }),
    );

    expect(result.isError).toBe(false);
    expect(await Bun.file(filePath).text()).toBe("after\n");
  });

  test("read-before-edit permission denies when mtime differs from snapshot", async () => {
    const filePath = await writeWorkspaceFile("mtime.txt", "content");
    const resolved = realpathSync.native(filePath);
    const ctx = makeCtx({ store: createMockStore({ readSnapshots: new Map([[resolved, 1]]) }) });

    const result = await executeThroughRegistry(
      { path: "mtime.txt", edits: [{ oldString: "content", newString: "updated" }] },
      ctx,
    );

    expectToolErrorKind(result, "write-conflict");
    expect(result.output).toContain("modified since it was read");
  });

  test("workspace ask falls through to read-before-edit when confirmation is unavailable", async () => {
    const result = await executeThroughRegistry(
      { path: "../outside.txt", edits: [{ oldString: "a", newString: "b" }] },
      makeCtx(),
    );

    expectToolErrorKind(result, "read-before-write");
    expect(result.output).toContain("has not been read first");
  });

  test("applies edits back-to-front so offsets remain stable", async () => {
    await writeWorkspaceFile("offsets.txt", "0123456789");
    const ctx = await makeReadCtx("offsets.txt");

    await fileEditTool.execute(
      {
        path: "offsets.txt",
        edits: [
          { oldString: "01", newString: "start" },
          { oldString: "89", newString: "end" },
        ],
      },
      ctx,
    );

    expect(await Bun.file(join(testDir, "offsets.txt")).text()).toBe("start234567end");
  });

  test("serializes concurrent edits to the same file with mutation queue", async () => {
    await writeWorkspaceFile("queue.txt", "one two three");
    const ctxA = await makeReadCtx("queue.txt");
    const ctxB = makeCtx({ store: ctxA.store });

    const results = await Promise.all([
      fileEditTool.execute(
        { path: "queue.txt", edits: [{ oldString: "one", newString: "1" }] },
        ctxA,
      ),
      fileEditTool.execute(
        { path: "queue.txt", edits: [{ oldString: "three", newString: "3" }] },
        ctxB,
      ),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ output: "Successfully applied 1 edit(s) to queue.txt", isError: false }),
      expect.objectContaining({ output: "Successfully applied 1 edit(s) to queue.txt", isError: false }),
    ]);
    expect(await Bun.file(join(testDir, "queue.txt")).text()).toBe("1 two 3");
  });

  test("after error recovery hook appends nudge while preserving structured edit errors", async () => {
    await writeWorkspaceFile("nudge.txt", "actual\n");
    const ctx = await makeReadCtx("nudge.txt");

    const result = await executeThroughRegistry(
      { path: "nudge.txt", edits: [{ oldString: "missing", newString: "value" }] },
      ctx,
    );

    expectToolErrorKind(result, "edit-no-match");
    expect(result.output).toContain("TOOL_EDIT_NO_MATCH");
    expect(result.output).toContain("---");
    expect(result.output).toContain("The oldString was not found in the file.");
  });

  test("refreshes read snapshot after successful edit", async () => {
    const filePath = await writeWorkspaceFile("snapshot.txt", "before\n");
    const oldDate = new Date(Date.now() - 10_000);
    await utimes(filePath, oldDate, oldDate);
    const store = await createReadStore(filePath);
    const beforeSnapshot = store.getState().readSnapshots.get(realpathSync.native(filePath));

    const ctx = makeCtx({ store });
    await fileEditTool.execute(
      { path: "snapshot.txt", edits: [{ oldString: "before", newString: "after" }] },
      ctx,
    );

    const resolved = realpathSync.native(filePath);
    const afterStat = statSync(resolved);
    expect(store.getState().readSnapshots.get(resolved)).toBe(afterStat.mtimeMs);
    expect(store.getState().readSnapshots.get(resolved)).not.toBe(beforeSnapshot);
  });

  test("validates input schema", () => {
    expect(
      fileEditTool.inputSchema.safeParse({
        path: "ok.txt",
        edits: [{ oldString: "old", newString: "new" }],
      }).success,
    ).toBe(true);
    expect(
      fileEditTool.inputSchema.safeParse({ path: "ok.txt", edits: [] }).success,
    ).toBe(false);
    expect(fileEditTool.inputSchema.safeParse({ path: "ok.txt" }).success).toBe(false);
    expect(
      fileEditTool.inputSchema.safeParse({
        path: "ok.txt",
        edits: [{ oldString: "", newString: "new" }],
      }).success,
    ).toBe(false);
    expect(
      fileEditTool.inputSchema.safeParse({
        path: "ok.txt",
        edits: [{ oldString: "old", newString: "new", extra: true }],
      }).success,
    ).toBe(false);
  });
});
