import {
  afterAll,
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
import { tmpdir } from "node:os";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/index";
import { createMockStore } from "../../store/test-helpers";
import { inferToolErrorKindFromResult } from "../errors";
import { createReadSnapshotAfterHook } from "../hooks";
import type { RawToolResult, RegistryExecutionOutcome, ToolExecutionContext } from "../types";
import { createTextToolResult } from "../results";
import { createTestToolRegistryFixture } from "../test-registry";
import { fileEditTool } from "./file-edit";
import { createTestProjectContext } from "../test-project-context";

const testDir = join(tmpdir(), "archcode-file-edit", crypto.randomUUID());
const canonicalProjectDir = join(tmpdir(), "archcode-file-edit-canonical-project", crypto.randomUUID());
const registryFixture = createTestToolRegistryFixture({ descriptors: [fileEditTool] });

type ToolTestResult = RawToolResult | RegistryExecutionOutcome;

function rawText(result: RawToolResult): string {
  if (result.draft.kind !== "text") throw new Error("Expected text draft");
  return result.draft.text;
}

function resultText(result: ToolTestResult): string {
  if ("kind" in result) {
    if (result.kind !== "settled") throw new Error("Expected settled Registry outcome");
    return result.result.output.preview;
  }
  return rawText(result);
}

function resultIsError(result: ToolTestResult): boolean {
  if ("kind" in result) {
    if (result.kind !== "settled") throw new Error("Expected settled Registry outcome");
    return result.result.isError;
  }
  return result.isError;
}

function resultErrorKind(result: ToolTestResult): string | undefined {
  if ("kind" in result) {
    if (result.kind !== "settled") throw new Error("Expected settled Registry outcome");
    return result.result.details?.error?.kind;
  }
  return inferToolErrorKindFromResult(result);
}

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
  return registryFixture.registry.execute(
    { toolCallId: ctx.toolCallId, toolName: "file_edit", input },
    ctx,
  );
}

function expectToolErrorKind(
  result: ToolTestResult,
  kind: NonNullable<ReturnType<typeof inferToolErrorKindFromResult>>,
): void {
  expect(resultIsError(result)).toBe(true);
  expect(resultErrorKind(result)).toBe(kind);
}

beforeEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await rm(canonicalProjectDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
  await mkdir(canonicalProjectDir, { recursive: true });
});

afterAll(async () => {
  await registryFixture.dispose();
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

    const result = await executeThroughRegistry(
      {
        path: join(stateLink, "blocked.txt"),
        edits: [{ oldString: "before", newString: "after" }],
      },
      makeCtx({
        projectContext: createTestProjectContext(canonicalProjectDir),
        store: await createReadStore(target),
      }),
    );

    expectToolErrorKind(result, "permission-denied");
    if (result.kind !== "settled") throw new Error("Expected settled Registry outcome");
    expect(result.result.details?.error?.code).toBe("PROTECTED_PATH_WRITE_DENIED");
    expect(await Bun.file(target).text()).toBe("before\n");
  });

  test("successfully applies a single edit", async () => {
    await writeWorkspaceFile("single.txt", "hello world\n");
    const ctx = await makeReadCtx("single.txt");

    const output = await fileEditTool.execute(
      { path: "single.txt", edits: [{ oldString: "world", newString: "archcode" }] },
      ctx,
    );

    const result = output;
    expect(rawText(result)).toBe("Successfully applied 1 edit(s) to single.txt");
    expect(result.isError).toBe(false);
    expect(result.details?.presentations).toContainEqual(expect.objectContaining({
      kind: "diff",
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "single.txt",
          status: "modified",
          additions: 1,
          deletions: 1,
        }),
      ]),
    }));
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

    expect(rawText(output)).toBe("Successfully applied 2 edit(s) to multiple.txt");
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

    expect(resultIsError(result)).toBe(true);
    expect(resultText(result)).toContain("Invalid input");
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

    expect(resultIsError(result)).toBe(false);
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
    expect(resultText(result)).toContain("TOOL_EDIT_NO_MATCH");
  });

  test("returns error when oldString matches multiple locations", async () => {
    await writeWorkspaceFile("ambiguous.txt", "repeat\nrepeat\n");
    const ctx = await makeReadCtx("ambiguous.txt");

    const result = await executeThroughRegistry(
      { path: "ambiguous.txt", edits: [{ oldString: "repeat", newString: "once" }] },
      ctx,
    );

    expectToolErrorKind(result, "edit-ambiguous");
    expect(resultText(result)).toContain("TOOL_EDIT_AMBIGUOUS_MATCH");
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
    expect(resultText(result)).toContain("TOOL_EDIT_OVERLAP");
  });

  test("returns error when oldString and newString are identical", async () => {
    await writeWorkspaceFile("identical.txt", "same\n");
    const ctx = await makeReadCtx("identical.txt");

    const result = await executeThroughRegistry(
      { path: "identical.txt", edits: [{ oldString: "same", newString: "same" }] },
      ctx,
    );

    expectToolErrorKind(result, "edit-identical");
    expect(resultText(result)).toContain("oldString and newString are identical");
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

    expectToolErrorKind(result, "file-not-found");
    expect(rawText(result)).toContain("TOOL_FILE_NOT_FOUND");
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

    expect(rawText(output)).toBe("Successfully applied 1 edit(s) to fuzzy.txt");
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
    expect(resultText(result)).toContain("not been read first");
  });

  test("file_read equivalent normalized path snapshot allows file_edit direct path", async () => {
    const filePath = await writeWorkspaceFile("src/main.ts", "before\n");
    const resolved = realpathSync.native(filePath);
    const store = createMockStore();
    const readCtx = makeCtx({ store, toolName: "file_read", input: { path: "src/../src/main.ts" } });

    await createReadSnapshotAfterHook()(createTextToolResult("1: before\n"), readCtx);

    expect(store.getState().readSnapshots.has(resolved)).toBe(true);

    const result = await executeThroughRegistry(
      { path: "src/main.ts", edits: [{ oldString: "before", newString: "after" }] },
      makeCtx({ store }),
    );

    expect(resultIsError(result)).toBe(false);
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
    expect(resultText(result)).toContain("modified since it was read");
  });

  test("workspace ask falls through to read-before-edit when confirmation is unavailable", async () => {
    const result = await executeThroughRegistry(
      { path: "../outside.txt", edits: [{ oldString: "a", newString: "b" }] },
      makeCtx(),
    );

    expectToolErrorKind(result, "read-before-write");
    expect(resultText(result)).toContain("has not been read first");
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

    expect(results.map(rawText)).toEqual([
      "Successfully applied 1 edit(s) to queue.txt",
      "Successfully applied 1 edit(s) to queue.txt",
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
    expect(resultText(result)).toContain("TOOL_EDIT_NO_MATCH");
    expect(resultText(result)).toContain("---");
    expect(resultText(result)).toContain("The oldString was not found in the file.");
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
