import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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

const testDir = join(import.meta.dir, "__test_tmp__", "file-write");

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: createMockStore(),
    toolName: "file_write",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["file_write"]),
    workspaceRoot: testDir,
    ...overrides,
  };
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
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("fileWriteTool", () => {
  test("successfully creates a new file and writes content", async () => {
    const output = await fileWriteTool.execute(
      { path: "sample.txt", content: "hello\nworld\n" },
      makeCtx(),
    );

    expect(output).toBe("File written to sample.txt");
    const content = await Bun.file(join(testDir, "sample.txt")).text();
    expect(content).toBe("hello\nworld\n");
  });

  test("file-exists guard denies existing files", async () => {
    const filePath = await writeWorkspaceFile("existing.txt", "old");
    const guard = fileWriteTool.guards?.[1];
    expect(guard).toBeDefined();

    const decision = await guard!(
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
    expect(result.output).toContain("already exists");

    const content = await Bun.file(join(testDir, "execute-existing.txt")).text();
    expect(content).toBe("old");
  });

  test("workspace guard denies paths outside workspace", async () => {
    const guard = fileWriteTool.guards?.[0];
    expect(guard).toBeDefined();

    const decision = await guard!(
      { path: "../outside.txt", content: "escape" },
      makeCtx(),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("outside workspace");
  });

  test("sensitive file guard asks for .env files", async () => {
    const guard = fileWriteTool.guards?.[2];
    expect(guard).toBeDefined();

    const decision = await guard!({ path: ".env", content: "SECRET=1" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("sensitive file");
    expect(decision.prompt).toContain("secrets or credentials");
  });

  test("sensitive file guard asks for .pem files", async () => {
    const guard = fileWriteTool.guards?.[2];
    expect(guard).toBeDefined();

    const decision = await guard!(
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

    expect(output).toBe("File written to nested/deep/file.txt");
    const content = await Bun.file(join(testDir, "nested/deep/file.txt")).text();
    expect(content).toBe("nested");
  });

  test("atomic write leaves the final file and no temp files after rename", async () => {
    const output = await fileWriteTool.execute(
      { path: "atomic.txt", content: "atomic content" },
      makeCtx(),
    );

    expect(output).toBe("File written to atomic.txt");
    expect(existsSync(join(testDir, "atomic.txt"))).toBe(true);
    expect(existsSync(join(testDir, `atomic.txt.tmp.${process.pid}.${Date.now()}`))).toBe(
      false,
    );
    const parentEntries = await Array.fromAsync(
      new Bun.Glob("atomic.txt.tmp.*").scan({ cwd: testDir }),
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
      "File written to parallel-a.txt",
      "File written to parallel-b.txt",
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
      (r) => r.status === "fulfilled" && r.value === "File written to same.txt",
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

    expect(output).toBe("File written to snapshot.txt");
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
