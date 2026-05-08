import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { realpathSync, statSync } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path, { join } from "node:path";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/index";
import { ToolRegistry } from "../registry";
import type { ToolExecutionContext } from "../types";
import { fileEditTool } from "./file-edit";

const testDir = join(import.meta.dir, "__test_tmp__", "file-edit");

function createMockStore(
  snapshots: Map<string, number> = new Map(),
): StoreApi<SessionStoreState> {
  const state: SessionStoreState = {
    sessionId: "test",
    createdAt: Date.now(),
    messages: [],
    steps: [],
    isRunning: false,
    isStreamingModel: false,
    streamingTools: {},
    readSnapshots: new Map(snapshots),
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

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "file_edit",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["file_edit"]),
    workspaceRoot: testDir,
    ...overrides,
  };
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<string> {
  const filePath = join(testDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

async function createReadStore(filePath: string): Promise<StoreApi<SessionStoreState>> {
  const resolved = realpathSync.native(filePath);
  const fileStat = await stat(filePath);
  return createMockStore(new Map([[resolved, fileStat.mtimeMs]]));
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

beforeEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("fileEditTool", () => {
  test("successfully applies a single edit", async () => {
    await writeWorkspaceFile("single.txt", "hello world\n");
    const ctx = await makeReadCtx("single.txt");

    const output = await fileEditTool.execute(
      { path: "single.txt", edits: [{ oldString: "world", newString: "specra" }] },
      ctx,
    );

    expect(output).toBe("Successfully applied 1 edit(s) to single.txt");
    expect(await readFile(join(testDir, "single.txt"), "utf8")).toBe("hello specra\n");
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

    expect(output).toBe("Successfully applied 2 edit(s) to multiple.txt");
    expect(await readFile(join(testDir, "multiple.txt"), "utf8")).toBe(
      "one beta three\n",
    );
  });

  test("prepareInput compat converts flat edit input", async () => {
    await writeWorkspaceFile("compat.txt", "before\n");
    const ctx = await makeReadCtx("compat.txt");

    const result = await executeThroughRegistry(
      { path: "compat.txt", oldString: "before", newString: "after" },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBe("Successfully applied 1 edit(s) to compat.txt");
    expect(await readFile(join(testDir, "compat.txt"), "utf8")).toBe("after\n");
  });

  test("returns error when oldString is not found", async () => {
    await writeWorkspaceFile("missing.txt", "actual content\n");
    const ctx = await makeReadCtx("missing.txt");

    const result = await executeThroughRegistry(
      { path: "missing.txt", edits: [{ oldString: "needle", newString: "value" }] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("[TOOL_EDIT_NO_MATCH]");
  });

  test("returns error when oldString matches multiple locations", async () => {
    await writeWorkspaceFile("ambiguous.txt", "repeat\nrepeat\n");
    const ctx = await makeReadCtx("ambiguous.txt");

    const result = await executeThroughRegistry(
      { path: "ambiguous.txt", edits: [{ oldString: "repeat", newString: "once" }] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("[TOOL_EDIT_AMBIGUOUS_MATCH]");
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

    expect(result.isError).toBe(true);
    expect(result.output).toContain("[TOOL_EDIT_OVERLAP]");
  });

  test("returns error when oldString and newString are identical", async () => {
    await writeWorkspaceFile("identical.txt", "same\n");
    const ctx = await makeReadCtx("identical.txt");

    const result = await executeThroughRegistry(
      { path: "identical.txt", edits: [{ oldString: "same", newString: "same" }] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("oldString and newString are identical");
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

    expect(output).toBe("Successfully applied 1 edit(s) to fuzzy.txt");
    expect(await readFile(join(testDir, "fuzzy.txt"), "utf8")).toBe(
      "const text = 'updated';\nnext line\r\n",
    );
  });

  test("read-before-edit guard denies when file was not read", async () => {
    await writeWorkspaceFile("not-read.txt", "content");
    const ctx = makeCtx();

    const result = await executeThroughRegistry(
      { path: "not-read.txt", edits: [{ oldString: "content", newString: "updated" }] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not been read first");
  });

  test("read-before-edit guard denies when mtime differs from snapshot", async () => {
    const filePath = await writeWorkspaceFile("mtime.txt", "content");
    const resolved = realpathSync.native(filePath);
    const ctx = makeCtx({ store: createMockStore(new Map([[resolved, 1]])) });

    const result = await executeThroughRegistry(
      { path: "mtime.txt", edits: [{ oldString: "content", newString: "updated" }] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("modified since it was read");
  });

  test("workspace guard denies paths outside workspace", async () => {
    const result = await executeThroughRegistry(
      { path: "../outside.txt", edits: [{ oldString: "a", newString: "b" }] },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("outside workspace");
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

    expect(await readFile(join(testDir, "offsets.txt"), "utf8")).toBe("start234567end");
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
      "Successfully applied 1 edit(s) to queue.txt",
      "Successfully applied 1 edit(s) to queue.txt",
    ]);
    expect(await readFile(join(testDir, "queue.txt"), "utf8")).toBe("1 two 3");
  });

  test("after error recovery hook appends cognitive nudge", async () => {
    await writeWorkspaceFile("nudge.txt", "actual\n");
    const ctx = await makeReadCtx("nudge.txt");

    const result = await executeThroughRegistry(
      { path: "nudge.txt", edits: [{ oldString: "missing", newString: "value" }] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("---");
    expect(result.output).toContain("Try re-reading the file");
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
