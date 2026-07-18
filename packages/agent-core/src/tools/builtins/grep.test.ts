import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setProcessRunnerForTest } from "../../process/runner";
import { storeManager } from "../../store/store";
import { inferToolErrorKindFromResult } from "../errors";
import type { RipgrepService } from "../ripgrep/service";
import { createTestProjectContext } from "../test-project-context";
import type { ToolExecutionContext } from "../types";
import { GrepInputSchema, grepTool, setRipgrepService } from "./grep";
import { SOURCE_PAGE_MAX_BYTES, SOURCE_PAGE_MAX_LINES, sourceDraftText } from "./source-page";

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

function processResult(stdout: string, stderr = "", exitCode = 0) {
  return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(exitCode), exitCode, kill: mock(() => undefined) };
}

function ctx(): ToolExecutionContext {
  return {
    store: {} as any, storeManager, toolName: "grep", toolCallId: "call", input: {}, step: 1,
    abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["grep"]),
    cwd: "/workspace", projectContext: createTestProjectContext("/workspace"),
  };
}

function ndjson(path: string, line: number, content: string): string {
  return `${JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text: content }, line_number: line } })}\n`;
}

beforeEach(() => {
  setRipgrepService({ ensure: mock(async () => "/bin/rg") } as RipgrepService);
});
afterEach(() => setProcessRunnerForTest(undefined));

describe("grep source pages", () => {
  test("sorts by path and position and advances a schema-valid offset cursor", async () => {
    // ripgrep --sort path is the canonical ordering; fake stdout mirrors it.
    setProcessRunnerForTest(mock(() => processResult(ndjson("a.ts", 1, "first") + ndjson("a.ts", 4, "later") + ndjson("b.ts", 9, "b"))));
    const first = await grepTool.execute({ pattern: "x", output_mode: "content", offset: 0, limit: 2 }, ctx());
    expect(sourceDraftText(first)).toBe("snapshot: false\na.ts:1:first\na.ts:4:later");
    if (first.draft.kind !== "source" || first.draft.nextInput === undefined) throw new Error("Expected recovery");
    expect(GrepInputSchema.safeParse(first.draft.nextInput).success).toBe(true);
    expect(first.draft.nextInput.offset).toBe(2);

    const second = await grepTool.execute(first.draft.nextInput as any, ctx());
    expect(sourceDraftText(second)).toBe("snapshot: false\nb.ts:9:b");
    expect(second.draft.kind === "source" && second.draft.nextInput).toBeUndefined();
  });

  test("bounds every page to 50 KiB and 2,000 lines", async () => {
    const output = Array.from({ length: 1_000 }, (_, index) => ndjson(`f-${index}.ts`, index + 1, "x".repeat(100))).join("");
    setProcessRunnerForTest(mock(() => processResult(output)));
    const page = await grepTool.execute({ pattern: "x", output_mode: "content", offset: 0, limit: 1_000 }, ctx());
    expect(new TextEncoder().encode(sourceDraftText(page)).byteLength).toBeLessThanOrEqual(SOURCE_PAGE_MAX_BYTES);
    expect(sourceDraftText(page).split("\n").length).toBeLessThanOrEqual(SOURCE_PAGE_MAX_LINES);
    expect(page.draft.kind === "source" && page.draft.nextInput).toBeDefined();
  });

  test("sorts files/count modes and returns Raw errors", async () => {
    setProcessRunnerForTest(mock(() => processResult("a.ts\nz.ts\n")));
    const files = await grepTool.execute({ pattern: "x", output_mode: "files_with_matches", offset: 0, limit: 100 }, ctx());
    expect(sourceDraftText(files)).toBe("snapshot: false\na.ts\nz.ts");

    setProcessRunnerForTest(mock(() => processResult("", "bad pattern", 2)));
    const error = await grepTool.execute({ pattern: "[", output_mode: "content", offset: 0, limit: 100 }, ctx());
    expect(error.isError).toBe(true);
    expect(inferToolErrorKindFromResult(error)).toBe("grep-error");
  });

  test("fails closed when one rg NDJSON record exceeds the bounded collector", async () => {
    const oversized = ndjson("huge.ts", 1, "x".repeat(70 * 1024));
    setProcessRunnerForTest(mock(() => processResult(`${ndjson("before.ts", 1, "ok")}${oversized}`)));

    const result = await grepTool.execute({ pattern: "x", output_mode: "content", offset: 0, limit: 100 }, ctx());

    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_GREP_ERROR");
    expect(JSON.stringify(result.draft)).not.toContain("before.ts");
  });
});
