import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmod,
  mkdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/index";
import { fileReadTool } from "./file-read";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";

const testDir = join(import.meta.dir, "__test_tmp__", "file-read");

function createMockStore(): StoreApi<SessionStoreState> {
  const state: SessionStoreState = {
    sessionId: "test",
    createdAt: Date.now(),
    messages: [],
    steps: [],
    todos: [],
    isRunning: false,
    isStreamingModel: false,
    streamingTools: {},
    readSnapshots: new Map(),
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
    toolName: "file_read",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["file_read"]),
    workspaceRoot: testDir,
    ...overrides,
  };
}

async function writeWorkspaceFile(relativePath: string, content: string | Uint8Array): Promise<string> {
  const filePath = join(testDir, relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

async function runAfterHooks(result: ToolExecutionResult, ctx: ToolExecutionContext): Promise<void> {
  for (const hook of fileReadTool.hooks?.after ?? []) {
    await hook(result, ctx);
  }
}

beforeEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("fileReadTool", () => {
  test("successfully reads a file and returns line-numbered output", async () => {
    await writeWorkspaceFile("sample.txt", "first line\nsecond line\n");

    const output = await fileReadTool.execute({ path: "sample.txt" }, makeCtx());

    expect(output).toBe("1: first line\n2: second line\n");
  });

  test("reads with offset starting from the specified line", async () => {
    await writeWorkspaceFile("offset.txt", "one\ntwo\nthree\n");

    const output = await fileReadTool.execute(
      { path: "offset.txt", offset: 2 },
      makeCtx(),
    );

    expect(output).toBe("2: two\n3: three\n");
  });

  test("reads with limit restricting the number of lines", async () => {
    await writeWorkspaceFile("limit.txt", "one\ntwo\nthree\n");

    const output = await fileReadTool.execute(
      { path: "limit.txt", limit: 2 },
      makeCtx(),
    );

    expect(output).toBe("1: one\n2: two\n");
  });

  test("reads with both offset and limit", async () => {
    await writeWorkspaceFile("range.txt", "one\ntwo\nthree\nfour\n");

    const output = await fileReadTool.execute(
      { path: "range.txt", offset: 2, limit: 2 },
      makeCtx(),
    );

    expect(output).toBe("2: two\n3: three\n");
  });

  test("detects binary files and returns an appropriate message", async () => {
    await writeWorkspaceFile("binary.bin", new Uint8Array([65, 0, 66]));

    const output = await fileReadTool.execute({ path: "binary.bin" }, makeCtx());

    expect(output).toBe("Binary file, cannot display");
  });

  test("returns error for non-existent files", async () => {
    const result = (await fileReadTool.execute({ path: "missing.txt" }, makeCtx())) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("file-not-found");
    expect(result.meta?.[TOOL_ERROR_META_KEY]).toBeDefined();
    expect(result.output).toContain("File not found");
  });

  test("returns error for permission denied", async () => {
    const filePath = await writeWorkspaceFile("denied.txt", "secret");
    await chmod(filePath, 0o000);

    try {
      const result = (await fileReadTool.execute({ path: "denied.txt" }, makeCtx())) as ToolExecutionResult;

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("file-permission-denied");
      expect(result.output).toContain("Permission denied");
    } finally {
      await chmod(filePath, 0o600);
    }
  });

  test("workspace guard denies paths outside workspace", async () => {
    const guard = fileReadTool.guards?.[0];
    expect(guard).toBeDefined();

    const decision = await guard!({ path: "../outside.txt" }, makeCtx());

    expect(decision.outcome).toBe("deny");
    expect(decision.reason).toContain("outside workspace");
  });

  test("sensitive file guard asks for .env files", async () => {
    const guard = fileReadTool.guards?.[1];
    expect(guard).toBeDefined();

    const decision = await guard!({ path: ".env" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("sensitive file");
    expect(decision.prompt).toContain("secrets or credentials");
  });

  test("sensitive file guard asks for .pem files", async () => {
    const guard = fileReadTool.guards?.[1];
    expect(guard).toBeDefined();

    const decision = await guard!({ path: "cert.pem" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.prompt).toContain("secrets or credentials");
  });

  test("sensitive file guard allows regular files", async () => {
    const guard = fileReadTool.guards?.[1];
    expect(guard).toBeDefined();

    const decision = await guard!({ path: "README.md" }, makeCtx());

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("read-snapshot after hook records mtime after successful read", async () => {
    const filePath = await writeWorkspaceFile("snapshot.txt", "snapshot\n");
    const store = createMockStore();
    const ctx = makeCtx({ store, input: { path: "snapshot.txt" } });
    const output = await fileReadTool.execute({ path: "snapshot.txt" }, ctx);

    await runAfterHooks({ output: output as string, isError: false }, ctx);

    const resolved = await realpath(filePath);
    const fileStat = await stat(filePath);
    expect(store.getState().readSnapshots.get(resolved)).toBe(fileStat.mtimeMs);
  });

  test("validates input schema", () => {
    expect(fileReadTool.inputSchema.safeParse({ path: "ok.txt" }).success).toBe(true);
    expect(fileReadTool.inputSchema.safeParse({}).success).toBe(false);
    expect(
      fileReadTool.inputSchema.safeParse({ path: "ok.txt", extra: true }).success,
    ).toBe(false);
  });
});
