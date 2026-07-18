import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { storeManager } from "../../store/store";
import {
  chmod,
  mkdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { createMockStore } from "../../store/test-helpers";
import { fileReadTool } from "./file-read";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createTestProjectContext } from "../test-project-context";

const testDir = join(import.meta.dir, "__test_tmp__", "file-read", crypto.randomUUID());

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "file_read",
  toolCallId: "call-1",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  startedAt: Date.now(),
  allowedTools: new Set(["file_read"]),
  cwd: testDir,
  storeManager,
    projectContext: createTestProjectContext(testDir), ...overrides,  };
}

async function writeWorkspaceFile(relativePath: string, content: string | Uint8Array): Promise<string> {
  const filePath = join(testDir, relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await Bun.write(filePath, content);
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

  test("applies offset before the 50KB source window", async () => {
    const lines = Array.from(
      { length: 7_000 },
      (_, index) => `line-${index + 1}-${"x".repeat(12)}`,
    );
    await writeWorkspaceFile("large-lines.txt", `${lines.join("\n")}\n`);

    const output = await fileReadTool.execute(
      { path: "large-lines.txt", offset: 6_000, limit: 2 },
      makeCtx(),
    );

    expect(output).toBe(
      `6000: ${lines[5_999]}\n6001: ${lines[6_000]}\n`,
    );
  });

  test("only reports truncation when the selected line range exceeds 50KB", async () => {
    const lines = Array.from(
      { length: 1_200 },
      (_, index) => `line-${index + 1}-${"y".repeat(80)}`,
    );
    await writeWorkspaceFile("truncated.txt", `${lines.join("\n")}\n`);

    const limited = await fileReadTool.execute(
      { path: "truncated.txt", offset: 1_000, limit: 2 },
      makeCtx(),
    );
    const truncated = await fileReadTool.execute(
      { path: "truncated.txt", offset: 100 },
      makeCtx(),
    );

    expect(limited).toBe(`1000: ${lines[999]}\n1001: ${lines[1_000]}\n`);
    expect(truncated).toStartWith(`100: ${lines[99]}\n`);
    expect(truncated).toContain("[Output truncated:");
    expect(truncated).toContain("51200-byte source window");
  });

  test("does not emit a replacement character when 50KB splits UTF-8", async () => {
    await writeWorkspaceFile(
      "utf8-boundary.txt",
      `${"a".repeat(50 * 1024 - 1)}你-after-boundary\n`,
    );

    const output = await fileReadTool.execute(
      { path: "utf8-boundary.txt" },
      makeCtx(),
    );

    expect(output).toContain("[Output truncated:");
    expect(output).not.toContain("�");
    expect(output).not.toContain("你");
  });

  test("detects binary files and returns an appropriate message", async () => {
    await writeWorkspaceFile("binary.bin", new Uint8Array([65, 0, 66]));

    const output = await fileReadTool.execute({ path: "binary.bin" }, makeCtx());

    expect(output).toBe("Binary file, cannot display");
  });

  test("hard-rejects files larger than 10MB without suggesting pagination", async () => {
    await writeWorkspaceFile(
      "too-large.txt",
      new Uint8Array(10 * 1024 * 1024 + 1).fill(65),
    );

    const result = (await fileReadTool.execute(
      { path: "too-large.txt", offset: 2, limit: 1 },
      makeCtx(),
    )) as ToolExecutionResult;

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("file-too-large");
    expect(result.output).toContain("hard file-size limit is 10 MB");
    expect(result.output).not.toMatch(/use offset|read in chunks/i);
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

  test("workspace permission asks for paths outside workspace", async () => {
    const perm = fileReadTool.permissions?.[0];
    expect(perm).toBeDefined();

    const decision = await perm!({ path: "../outside.txt" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("outside workspace");
    expect(decision.approval?.scope).toMatchObject({ kind: "file-path", operation: "read", pathMode: "exact" });
  });

  test("sensitive file permission asks for .env files", async () => {
    const perm = fileReadTool.permissions?.[1];
    expect(perm).toBeDefined();

    const decision = await perm!({ path: ".env" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("sensitive file");
    expect(decision.prompt).toContain("secrets or credentials");
  });

  test("sensitive file permission asks for .pem files", async () => {
    const perm = fileReadTool.permissions?.[1];
    expect(perm).toBeDefined();

    const decision = await perm!({ path: "cert.pem" }, makeCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.prompt).toContain("secrets or credentials");
  });

  test("sensitive file permission allows regular files", async () => {
    const perm = fileReadTool.permissions?.[1];
    expect(perm).toBeDefined();

    const decision = await perm!({ path: "README.md" }, makeCtx());

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("read-snapshot after hook records mtime after successful read", async () => {
    const lines = Array.from({ length: 7_000 }, (_, index) => `snapshot-${index + 1}`);
    const filePath = await writeWorkspaceFile("snapshot.txt", `${lines.join("\n")}\n`);
    const store = createMockStore();
    const input = { path: "snapshot.txt", offset: 6_000, limit: 1 };
    const ctx = makeCtx({ store, input });
    const output = await fileReadTool.execute(input, ctx);

    expect(output).toBe("6000: snapshot-6000\n");

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
