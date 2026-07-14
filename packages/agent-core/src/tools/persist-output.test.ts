import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { silentLogger } from "../logger";
import type { CompletedToolPart, ErrorToolPart } from "../store/types";
import {
  persistToolOutput,
  persistToolOutputValue,
  TOOL_OUTPUT_DIR,
} from "./persist-output";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
const OUTPUT_DIR = join(TMP_DIR, "tool-output");

function makeCompletedToolPart(
  overrides: Partial<CompletedToolPart> = {},
): CompletedToolPart {
  return {
    type: "tool",
    id: overrides.id ?? "part-1",
    state: "completed",
    toolCallId: overrides.toolCallId ?? "call-abc-123",
    toolName: overrides.toolName ?? "bash",
    input: overrides.input ?? { command: "echo hello" },
    output: overrides.output ?? "hello world",
    createdAt: overrides.createdAt ?? Date.now(),
    startedAt: overrides.startedAt ?? Date.now(),
    endedAt: overrides.endedAt ?? Date.now(),
    meta: overrides.meta,
  };
}

function makeErrorToolPart(
  overrides: Partial<ErrorToolPart> = {},
): ErrorToolPart {
  return {
    type: "tool",
    id: overrides.id ?? "part-err-1",
    state: "error",
    toolCallId: overrides.toolCallId ?? "call-err-123",
    toolName: overrides.toolName ?? "bash",
    input: overrides.input ?? { command: "bad-command" },
    errorMessage: overrides.errorMessage ?? "command not found",
    createdAt: overrides.createdAt ?? Date.now(),
    startedAt: overrides.startedAt ?? Date.now(),
    endedAt: overrides.endedAt ?? Date.now(),
    meta: overrides.meta,
  };
}

afterAll(() => rm(TMP_DIR, { recursive: true, force: true }));

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

describe("persistToolOutput", () => {
  it("creates file and sets fullOutputPath for CompletedToolPart", async () => {
    const output = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
    const toolPart = makeCompletedToolPart({ output });
    const sessionId = "test-session-1";

    const result = await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("bash");
    expect(result).toContain("call-abc-123");
    expect(result).toContain(sessionId);
    expect(toolPart.meta).toBeDefined();
    expect(toolPart.meta!.fullOutputPath).toBe(result);

    const content = await Bun.file(result).text();
    expect(content).toBe(output);
  });

  it("creates file and sets fullOutputPath for ErrorToolPart", async () => {
    const errorMessage =
      "Error: something went wrong\nStack trace line 2\nStack trace line 3";
    const toolPart = makeErrorToolPart({ errorMessage });
    const sessionId = "test-session-2";

    const result = await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    expect(typeof result).toBe("string");
    expect(toolPart.meta).toBeDefined();
    expect(toolPart.meta!.fullOutputPath).toBe(result);

    const content = await Bun.file(result).text();
    expect(content).toBe(errorMessage);
  });

  it("is idempotent when fullOutputPath already exists", async () => {
    const toolPart = makeCompletedToolPart({ output: "original output" });
    const sessionId = "test-session-3";

    const result1 = await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    toolPart.output = "modified output";

    const result2 = await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    expect(result2).toBe(result1);

    const content = await Bun.file(result1).text();
    expect(content).toBe("original output");
  });

  it("re-persists when force is true", async () => {
    const toolPart = makeCompletedToolPart({ output: "original output" });
    const sessionId = "test-session-4";

    const result1 = await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    toolPart.output = "modified output";

    const result2 = await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
      force: true,
    });

    expect(result2).toBe(result1);

    const content = await Bun.file(result1).text();
    expect(content).toBe("modified output");
  });

  it("with previewLines: 0 produces reference-only output", async () => {
    const toolPart = makeCompletedToolPart({ output: "line1\nline2\nline3" });
    const sessionId = "test-session-5";

    await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
      previewLines: 0,
    });

    expect(toolPart.output).toBe(
      `[Output truncated; full output saved to: ${toolPart.meta!.fullOutputPath}]`,
    );
  });

  it("with previewLines: 5 produces 5-line preview", async () => {
    const toolPart = makeCompletedToolPart({
      output:
        "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10",
    });
    const sessionId = "test-session-6";

    await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
      previewLines: 5,
    });

    const expectedPreview = "line1\nline2\nline3\nline4\nline5";
    const marker = `[Output truncated; full output saved to: ${toolPart.meta!.fullOutputPath}]`;
    expect(toolPart.output).toBe(`${expectedPreview}\n${marker}`);
  });

  it("updates errorMessage for ErrorToolPart based on previewLines", async () => {
    const toolPart = makeErrorToolPart({
      errorMessage:
        "err1\nerr2\nerr3\nerr4\nerr5\nerr6\nerr7",
    });
    const sessionId = "test-session-7";

    await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
      previewLines: 3,
    });

    const expectedPreview = "err1\nerr2\nerr3";
    const marker = `[Output truncated; full output saved to: ${toolPart.meta!.fullOutputPath}]`;
    expect(toolPart.errorMessage).toBe(`${expectedPreview}\n${marker}`);
  });

  it("handles write failure gracefully", async () => {
    const toolPart = makeCompletedToolPart({ output: "some output" });
    const sessionId = "test-session-8";

    await mkdir(OUTPUT_DIR, { recursive: true });
    await Bun.write(join(OUTPUT_DIR, sessionId), "blocker");

    const result = await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    expect(result).toBe("");
    expect(toolPart.meta?.fullOutputPath).toBeUndefined();
    expect(toolPart.output).toBe("some output");
  });

  it("creates meta object if undefined", async () => {
    const toolPart = makeCompletedToolPart({ output: "test output" });
    expect(toolPart.meta).toBeUndefined();

    const sessionId = "test-session-meta";

    await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    expect(toolPart.meta).toBeDefined();
    expect(toolPart.meta!.fullOutputPath).toBeDefined();
  });

  it("preserves existing meta fields", async () => {
    const toolPart = makeCompletedToolPart({
      output: "test output",
      meta: { customField: "custom-value" },
    });
    const sessionId = "test-session-meta-preserve";

    await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    expect(toolPart.meta!.customField).toBe("custom-value");
    expect(toolPart.meta!.fullOutputPath).toBeDefined();
  });

  it("uses default previewLines (5) when not specified", async () => {
    const toolPart = makeCompletedToolPart({
      output:
        "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10",
    });
    const sessionId = "test-session-default-preview";

    await persistToolOutput(toolPart, sessionId, {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    const expectedPreview = "line1\nline2\nline3\nline4\nline5";
    const marker = `[Output truncated; full output saved to: ${toolPart.meta!.fullOutputPath}]`;
    expect(toolPart.output).toBe(`${expectedPreview}\n${marker}`);
  });

  it("uses TOOL_OUTPUT_DIR as default outputDir", async () => {
    expect(typeof TOOL_OUTPUT_DIR).toBe("string");
    expect(TOOL_OUTPUT_DIR).toContain("tool-output");
    expect(TOOL_OUTPUT_DIR).toContain(".archcode");
  });
});

describe("persistToolOutputValue", () => {
  it("works directly with raw output strings", async () => {
    const rawOutput =
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
    const toolName = "bash";
    const callId = "call-xyz-789";
    const sessionId = "test-session-9";

    const result = await persistToolOutputValue(
      rawOutput,
      toolName,
      callId,
      sessionId,
      { logger: silentLogger, outputDir: OUTPUT_DIR },
    );

    expect(typeof result.fullPath).toBe("string");
    expect(result.fullPath).toContain(toolName);
    expect(result.fullPath).toContain(callId);
    expect(result.fullPath).toContain(sessionId);

    const content = await Bun.file(result.fullPath).text();
    expect(content).toBe(rawOutput);

    expect(result.updatedOutput).toContain(
      "[Output truncated; full output saved to:",
    );
  });

  it("with previewLines: 0 produces reference-only output", async () => {
    const rawOutput = "line1\nline2\nline3";

    const result = await persistToolOutputValue(rawOutput, "bash", "call-1", "session-1", {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
      previewLines: 0,
    });

    expect(result.updatedOutput).toBe(
      `[Output truncated; full output saved to: ${result.fullPath}]`,
    );
  });

  it("with previewLines: 3 produces 3-line preview", async () => {
    const rawOutput = "line1\nline2\nline3\nline4\nline5";

    const result = await persistToolOutputValue(rawOutput, "bash", "call-2", "session-2", {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
      previewLines: 3,
    });

    expect(result.updatedOutput).toBe(
      `line1\nline2\nline3\n[Output truncated; full output saved to: ${result.fullPath}]`,
    );
  });

  it("handles write failure gracefully", async () => {
    const rawOutput = "some output";

    await mkdir(OUTPUT_DIR, { recursive: true });
    await Bun.write(join(OUTPUT_DIR, "session-blocked"), "blocker");

    const result = await persistToolOutputValue(
      rawOutput,
      "bash",
      "call-blocked",
      "session-blocked",
      { logger: silentLogger, outputDir: OUTPUT_DIR },
    );

    expect(result.fullPath).toBe("");
    expect(result.updatedOutput).toBe(rawOutput);
  });

  it("uses default previewLines (5) when not specified", async () => {
    const rawOutput =
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";

    const result = await persistToolOutputValue(rawOutput, "bash", "call-3", "session-3", {
      logger: silentLogger,
      outputDir: OUTPUT_DIR,
    });

    const expectedPreview = "line1\nline2\nline3\nline4\nline5";
    const marker = `[Output truncated; full output saved to: ${result.fullPath}]`;
    expect(result.updatedOutput).toBe(`${expectedPreview}\n${marker}`);
  });

  it("produces deterministic file path based on toolName and callId", async () => {
    const rawOutput = "test output";

    const result1 = await persistToolOutputValue(
      rawOutput,
      "bash",
      "call-deterministic",
      "session-d",
      { logger: silentLogger, outputDir: OUTPUT_DIR },
    );

    const result2 = await persistToolOutputValue(
      rawOutput,
      "bash",
      "call-deterministic",
      "session-d",
      { logger: silentLogger, outputDir: OUTPUT_DIR },
    );

    expect(result1.fullPath).toBe(result2.fullPath);
  });

  it("sanitizes special characters in toolName and callId", async () => {
    const rawOutput = "test output";

    const result = await persistToolOutputValue(
      rawOutput,
      "my tool/name",
      "call/special chars",
      "session-sanitize",
      { logger: silentLogger, outputDir: OUTPUT_DIR },
    );

    expect(result.fullPath).toContain("my_tool_name");
    expect(result.fullPath).toContain("call_special_chars");
  });
});
