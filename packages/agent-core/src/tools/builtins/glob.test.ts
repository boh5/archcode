import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setProcessRunnerForTest } from "../../process/runner";
import { storeManager } from "../../store/store";
import { inferToolErrorKindFromResult } from "../errors";
import type { RipgrepService } from "../ripgrep/service";
import { createTestProjectContext } from "../test-project-context";
import type { ToolExecutionContext } from "../types";
import { GlobInputSchema, globTool, setRipgrepService } from "./glob";
import { SOURCE_PAGE_MAX_BYTES, SOURCE_PAGE_MAX_LINES, sourceDraftText } from "./source-page";

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

function processResult(stdout: string, stderr = "", exitCode = 0) {
  return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(exitCode), exitCode, kill: mock(() => undefined) };
}

function ctx(): ToolExecutionContext {
  return {
    store: {} as any, storeManager, toolName: "glob", toolCallId: "call", input: {}, step: 1,
    abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["glob"]),
    cwd: "/workspace", projectContext: createTestProjectContext("/workspace"),
  };
}

beforeEach(() => setRipgrepService({ ensure: mock(async () => "/bin/rg") } as RipgrepService));
afterEach(() => setProcessRunnerForTest(undefined));

describe("glob source pages", () => {
  test("sorts paths and advances a schema-valid offset cursor with snapshot false", async () => {
    // ripgrep --sort path is the canonical ordering; fake stdout mirrors it.
    setProcessRunnerForTest(mock(() => processResult("a.ts\nb.ts\nc.ts\n")));
    const first = await globTool.execute({ pattern: "*.ts", offset: 0, limit: 2 }, ctx());
    expect(sourceDraftText(first)).toBe("snapshot: false\na.ts\nb.ts");
    if (first.draft.kind !== "source" || first.draft.nextInput === undefined) throw new Error("Expected recovery");
    expect(GlobInputSchema.safeParse(first.draft.nextInput).success).toBe(true);
    expect(first.draft.nextInput.offset).toBe(2);

    const second = await globTool.execute(first.draft.nextInput as any, ctx());
    expect(sourceDraftText(second)).toBe("snapshot: false\nc.ts");
    expect(second.draft.kind === "source" && second.draft.nextInput).toBeUndefined();
  });

  test("bounds page bytes and lines", async () => {
    const files = Array.from({ length: 2_500 }, (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(30)}.ts`);
    setProcessRunnerForTest(mock(() => processResult(`${files.join("\n")}\n`)));
    const page = await globTool.execute({ pattern: "*.ts", offset: 0, limit: 1_000 }, ctx());
    expect(new TextEncoder().encode(sourceDraftText(page)).byteLength).toBeLessThanOrEqual(SOURCE_PAGE_MAX_BYTES);
    expect(sourceDraftText(page).split("\n").length).toBeLessThanOrEqual(SOURCE_PAGE_MAX_LINES);
    expect(page.draft.kind === "source" && page.draft.nextInput).toBeDefined();
  });

  test("reaches a sentinel beyond the ProcessRunner 1 MiB diagnostic ring", async () => {
    const prefix = Array.from({ length: 30_000 }, (_, index) => `${String(index).padStart(5, "0")}-${"x".repeat(32)}.ts`);
    const sentinel = "zzzzz-SOURCE_SENTINEL.ts";
    setProcessRunnerForTest(mock(() => processResult(`${prefix.join("\n")}\n${sentinel}\n`)));
    const page = await globTool.execute({ pattern: "*.ts", offset: prefix.length, limit: 1 }, ctx());
    expect(sourceDraftText(page)).toContain(sentinel);
    expect(page.draft.kind === "source" && page.draft.nextInput).toBeUndefined();
  });

  test("returns source empty state and Raw errors", async () => {
    setProcessRunnerForTest(mock(() => processResult("")));
    expect(sourceDraftText(await globTool.execute({ pattern: "*.none", offset: 0, limit: 100 }, ctx()))).toContain("No files matched");

    setProcessRunnerForTest(mock(() => processResult("", "bad glob", 2)));
    const error = await globTool.execute({ pattern: "[", offset: 0, limit: 100 }, ctx());
    expect(error.isError).toBe(true);
    expect(inferToolErrorKindFromResult(error)).toBe("glob-error");
  });

  test("fails closed when one rg path record exceeds the bounded collector", async () => {
    setProcessRunnerForTest(mock(() => processResult(`before.ts\n${"x".repeat(70 * 1024)}.ts\n`)));

    const result = await globTool.execute({ pattern: "*.ts", offset: 0, limit: 100 }, ctx());

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_GLOB_ERROR");
    expect(JSON.stringify(result.draft)).not.toContain("before.ts");
  });
});
