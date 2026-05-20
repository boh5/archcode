import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { REDACTION_MARKER } from "../security";
import { createRedactionHook } from "./redact";
import { createOutputTruncator } from "./truncate";
import { persistToolOutputValue, TOOL_OUTPUT_DIR } from "../persist-output";
import { createTestProjectContext } from "../test-project-context";

const TMP_DIR = join(import.meta.dir, "__test_tmp__");
const OUTPUT_DIR = join(TMP_DIR, "tool-output");

const TEST_SESSION_ID = "test-session";

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: {
      getState: () => ({ sessionId: TEST_SESSION_ID }),
    } as ToolExecutionContext["store"],
    toolName: overrides.toolName ?? "bash",
    toolCallId: overrides.toolCallId ?? "call-abc-123",
    input: overrides.input ?? { command: "echo hello" },
    step: overrides.step ?? 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    durationMs: overrides.durationMs ?? 42,
    allowedTools: new Set<string>(),
    workspaceRoot: "/tmp",
    projectContext: createTestProjectContext("/tmp"),
    ...overrides,
  };
}

function makeResult(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    output: overrides.output ?? "hello world",
    isError: overrides.isError ?? false,
    meta: overrides.meta ?? {},
  };
}

afterAll(() => rm(TMP_DIR, { recursive: true, force: true }));

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

describe("createOutputTruncator", () => {
  it("returns an AfterHook function", () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR });
    expect(typeof hook).toBe("function");
  });

  it("returns void when output is under all limits", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR });
    const result = makeResult({ output: "small output" });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
  });

  it("returns void when output is at maxBytes boundary", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 5, maxLines: 2000 });
    const result = makeResult({ output: "abc\nd" });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
  });

  it("truncates when output exceeds maxBytes", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 10, maxLines: 2000 });
    const fullOutput = "long output here!";
    const result = makeResult({ output: fullOutput });
    const ctx = makeCtx({ toolName: "bash", toolCallId: "call-bytes" });

    const returned = await hook(result, ctx);
    expect(returned).toBeDefined();
    expect(returned!.isError).toBe(false);
    expect(returned!.output).toContain("[Output truncated; full output saved to:");
    expect(returned!.meta!.truncated).toBe(true);
    expect(typeof returned!.meta!.fullOutputPath).toBe("string");
    expect((returned!.meta!.fullOutputPath as string).startsWith(OUTPUT_DIR)).toBe(true);

    const sessionDir = join(OUTPUT_DIR, TEST_SESSION_ID);
    const files = await readdir(sessionDir);
    expect(files.length).toBe(1);
    const savedContent = await Bun.file(join(sessionDir, files[0]!)).text();
    expect(savedContent).toBe(fullOutput);
  });

  it("truncates when output exceeds maxLines", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 1024 * 1024, maxLines: 3 });
    const fullOutput = "line1\nline2\nline3\nline4\nline5\n";
    const result = makeResult({ output: fullOutput });
    const ctx = makeCtx({ toolName: "ffmpeg", toolCallId: "call-lines" });

    const returned = await hook(result, ctx);
    expect(returned).toBeDefined();
    expect(returned!.output).toContain("[Output truncated; full output saved to:");
    expect(returned!.meta!.truncated).toBe(true);
    expect(typeof returned!.meta!.fullOutputPath).toBe("string");

    const sessionDir = join(OUTPUT_DIR, TEST_SESSION_ID);
    const files = await readdir(sessionDir);
    expect(files.length).toBe(1);
    const savedContent = await Bun.file(join(sessionDir, files[0]!)).text();
    expect(savedContent).toBe(fullOutput);
  });

  it("preserves isError from original result", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 5, maxLines: 2000 });
    const result = makeResult({ output: "X".repeat(100), isError: true });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned!.isError).toBe(true);
  });

  it("creates output directory automatically when missing", async () => {
    await rm(OUTPUT_DIR, { recursive: true, force: true });

    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 5, maxLines: 2000 });
    const result = makeResult({ output: "X".repeat(100) });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeDefined();
    expect(returned!.meta!.truncated).toBe(true);

    const sessionDir = join(OUTPUT_DIR, TEST_SESSION_ID);
    const files = await readdir(sessionDir);
    expect(files.length).toBe(1);
  });

  it("uses default limits when no options provided", async () => {
    const hook = createOutputTruncator();
    const result = makeResult({ output: "small" });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    expect(returned).toBeUndefined();
  });

  it("produces unique filenames for different calls", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 5, maxLines: 2000 });
    const bigOutput = "X".repeat(100);

    const returned1 = await hook(makeResult({ output: bigOutput }), makeCtx({ toolCallId: "call-1" }));
    const returned2 = await hook(makeResult({ output: bigOutput }), makeCtx({ toolCallId: "call-2" }));

    expect(returned1!.meta!.fullOutputPath).not.toBe(returned2!.meta!.fullOutputPath);
    const sessionDir = join(OUTPUT_DIR, TEST_SESSION_ID);
    const files = await readdir(sessionDir);
    expect(files.length).toBe(2);
  });

  it("includes toolName and toolCallId in saved filename", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 5, maxLines: 2000 });
    const result = makeResult({ output: "X".repeat(100) });
    const ctx = makeCtx({ toolName: "rm-rf", toolCallId: "call-xyz" });

    const returned = await hook(result, ctx);
    const filename = (returned!.meta!.fullOutputPath as string).split("/").pop()!;
    expect(filename).toContain("rm-rf");
    expect(filename).toContain("call-xyz");
  });

  it("adds truncated marker with exact format", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 5, maxLines: 2000 });
    const result = makeResult({ output: "X".repeat(100) });
    const ctx = makeCtx();

    const returned = await hook(result, ctx);
    const fullPath = returned!.meta!.fullOutputPath as string;
    const expected = `[Output truncated; full output saved to: ${fullPath}]`;
    expect(returned!.output).toContain(expected);
  });

  it("truncates both success and error results", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 5, maxLines: 2000 });
    const bigOutput = "X".repeat(100);

    const successResult = await hook(makeResult({ output: bigOutput, isError: false }), makeCtx({ toolCallId: "success" }));
    const errorResult = await hook(makeResult({ output: bigOutput, isError: true }), makeCtx({ toolCallId: "error" }));

    expect(successResult!.meta!.truncated).toBe(true);
    expect(errorResult!.meta!.truncated).toBe(true);
    expect(successResult!.isError).toBe(false);
    expect(errorResult!.isError).toBe(true);
  });

  it("persists redacted full output when redaction runs before truncation", async () => {
    const rawSecret = "sk_test_1234567890abcdef";
    const redactor = createRedactionHook();
    const truncator = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 30, maxLines: 3 });
    const ctx = makeCtx({ input: { command: `token=${rawSecret}` } });
    const longOutput = ["line1", "line2", "line3", "line4", `line5 token=${rawSecret}`].join("\n");

    const redacted = await redactor(makeResult({ output: longOutput }), ctx);
    const returned = await truncator(redacted!, ctx);

    const savedContent = await Bun.file(returned!.meta!.fullOutputPath as string).text();
    expect(savedContent).toContain(REDACTION_MARKER);
    expect(savedContent).not.toContain(rawSecret);
  });

  it("uses shared persistToolOutputValue for persistence", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 5, maxLines: 2000 });
    const fullOutput = "X".repeat(100);
    const result = makeResult({ output: fullOutput });
    const ctx = makeCtx({ toolName: "bash", toolCallId: "call-shared" });

    const returned = await hook(result, ctx);
    const fullPath = returned!.meta!.fullOutputPath as string;

    const directResult = await persistToolOutputValue(
      fullOutput,
      "bash",
      "call-shared",
      TEST_SESSION_ID,
      { outputDir: OUTPUT_DIR },
    );

    expect(fullPath).toBe(directResult.fullPath);
  });

  it("sets fullOutputPath compatible with persistToolOutputValue format", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 5, maxLines: 2000 });
    const result = makeResult({ output: "X".repeat(100) });
    const ctx = makeCtx({ toolName: "memory_read", toolCallId: "call-mem" });

    const returned = await hook(result, ctx);
    const fullPath = returned!.meta!.fullOutputPath as string;

    expect(fullPath).toContain(TEST_SESSION_ID);
    expect(fullPath).toContain("memory_read");
    expect(fullPath).toContain("call-mem");
    expect(fullPath).toMatch(/-full\.txt$/);
  });

  it("truncates large memory_read output through shared path", async () => {
    const hook = createOutputTruncator({ outputDir: OUTPUT_DIR, maxBytes: 100, maxLines: 5 });
    const memoryContent = Array.from({ length: 100 }, (_, i) => `Memory line ${i + 1}`).join("\n");
    const result = makeResult({ output: memoryContent });
    const ctx = makeCtx({ toolName: "memory_read", toolCallId: "call-mem-large" });

    const returned = await hook(result, ctx);

    expect(returned).toBeDefined();
    expect(returned!.meta!.truncated).toBe(true);
    expect(typeof returned!.meta!.fullOutputPath).toBe("string");

    const savedContent = await Bun.file(returned!.meta!.fullOutputPath as string).text();
    expect(savedContent).toBe(memoryContent);
  });
});
