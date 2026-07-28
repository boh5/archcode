import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { storeManager } from "../../store/store";
import { createMockStore } from "../../store/test-helpers";
import { inferToolErrorKindFromResult } from "../errors";
import { createTestProjectContext } from "../test-project-context";
import type { RawToolResult, ToolExecutionContext } from "../types";
import { fileReadTool } from "./file-read";
import { SOURCE_PAGE_MAX_BYTES, SOURCE_PAGE_MAX_LINES, sourceDraftText } from "./source-page";

// Keep mutable fixtures out of the source worktree: constrained runners can mount it read-only.
const workspace = join("/tmp", "archcode-file-read-source", crypto.randomUUID());

function ctx(): ToolExecutionContext {
  return {
    store: createMockStore(), storeManager, toolName: "file_read", toolCallId: "call", input: {}, step: 1,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
    abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["file_read"]),
    cwd: workspace, projectContext: createTestProjectContext(workspace),
  };
}

async function write(name: string, value: string | Uint8Array): Promise<void> {
  await Bun.write(join(workspace, name), value);
}

beforeEach(async () => { await rm(workspace, { recursive: true, force: true }); await mkdir(workspace, { recursive: true }); });
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

describe("file_read source pages", () => {
  test("returns a Raw SourcePageDraft", async () => {
    await write("sample.txt", "first\nsecond\n");
    const result = await fileReadTool.execute({ path: "sample.txt" }, ctx());
    expect(result).toEqual({ isError: false, draft: { kind: "source", text: "1: first\n2: second" } });
  });

  test("enforces 50 KiB and 2,000 lines with schema-valid forward recovery", async () => {
    const lines = Array.from({ length: 3_000 }, (_, index) => `line-${index + 1}-${"x".repeat(30)}`);
    await write("large.txt", `${lines.join("\n")}\n`);

    const first = await fileReadTool.execute({ path: "large.txt" }, ctx());
    expect(first.draft.kind).toBe("source");
    expect(new TextEncoder().encode(sourceDraftText(first)).byteLength).toBeLessThanOrEqual(SOURCE_PAGE_MAX_BYTES);
    expect(sourceDraftText(first).split("\n").length).toBeLessThanOrEqual(SOURCE_PAGE_MAX_LINES);
    if (first.draft.kind !== "source" || first.draft.nextInput === undefined) throw new Error("Expected recovery");
    expect(fileReadTool.inputSchema.safeParse(first.draft.nextInput).success).toBe(true);

    let page: RawToolResult = first;
    let previousOffset = 0;
    let sawSentinel = false;
    for (let index = 0; index < 10; index += 1) {
      sawSentinel ||= sourceDraftText(page).includes("3000: line-3000-");
      if (page.draft.kind !== "source" || page.draft.nextInput === undefined) break;
      const nextOffset = Number(page.draft.nextInput.offset);
      expect(nextOffset).toBeGreaterThan(previousOffset);
      previousOffset = nextOffset;
      page = await fileReadTool.execute(page.draft.nextInput as any, ctx());
    }
    sawSentinel ||= sourceDraftText(page).includes("3000: line-3000-");
    expect(sawSentinel).toBe(true);
    expect(page.draft.kind === "source" && page.draft.nextInput).toBeUndefined();
  });

  test("returns bounded structured errors and rejects files containing NUL anywhere", async () => {
    const missing = await fileReadTool.execute({ path: "missing.txt" }, ctx());
    expect(missing.isError).toBe(true);
    expect(inferToolErrorKindFromResult(missing)).toBe("file-not-found");

    const bytes = new Uint8Array(9 * 1024);
    bytes.fill(65);
    bytes[bytes.length - 1] = 0;
    await write("binary.bin", bytes);
    const binary = await fileReadTool.execute({ path: "binary.bin" }, ctx());
    expect(binary.isError).toBe(true);
    expect(binary.draft.kind).toBe("text");
    if (binary.draft.kind !== "text") throw new Error("Expected text error");
    expect(binary.draft.text).toContain("contains a NUL byte");
  });

  test("rejects invalid UTF-8 without a NUL byte", async () => {
    await write("invalid-utf8.txt", new Uint8Array([0x66, 0x6f, 0x80, 0x6f]));
    const result = await fileReadTool.execute({ path: "invalid-utf8.txt" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.draft.kind).toBe("text");
    if (result.draft.kind !== "text") throw new Error("Expected text error");
    expect(result.draft.text).toContain("not valid UTF-8 text");
  });

  test("accepts exactly 10 MiB and rejects one byte more", async () => {
    const atLimitBytes = new Uint8Array(10 * 1024 * 1024).fill(65);
    for (let index = 100; index < atLimitBytes.length; index += 101) atLimitBytes[index] = 10;
    await write("limit.txt", atLimitBytes);
    const atLimit = await fileReadTool.execute({ path: "limit.txt" }, ctx());
    expect(atLimit.isError).toBe(false);

    const overLimitBytes = new Uint8Array(10 * 1024 * 1024 + 1).fill(65);
    for (let index = 100; index < overLimitBytes.length; index += 101) overLimitBytes[index] = 10;
    await write("over-limit.txt", overLimitBytes);
    const overLimit = await fileReadTool.execute({ path: "over-limit.txt" }, ctx());
    expect(overLimit.isError).toBe(true);
    expect(inferToolErrorKindFromResult(overLimit)).toBe("file-too-large");
  });

  test("keeps workspace and sensitive-file permissions", async () => {
    expect((await fileReadTool.permissions![0]!({ path: "../outside" }, ctx())).outcome).toBe("ask");
    expect((await fileReadTool.permissions![1]!({ path: ".env" }, ctx())).outcome).toBe("ask");
  });
});
