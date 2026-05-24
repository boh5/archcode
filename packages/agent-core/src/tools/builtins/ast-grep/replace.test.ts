import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { BinaryManager, setBinaryManagerForTest } from "../../../binary/manager";
import { setProcessRunnerForTest } from "../../../process/runner";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../../errors";
import { createTestProjectContext } from "../../test-project-context";
import type { FormattedToolError, ToolErrorKind } from "../../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { AstGrepReplaceInputSchema, astGrepReplaceTool, buildAstGrepReplaceArgs } from "./replace";

function stream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close(); } });
}

function spawnResult(stdout: string, stderr = "", exitCode = 0, signalCode?: string) {
  return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(exitCode), exitCode, signalCode, kill: mock(() => undefined) };
}

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    store: {} as any,
    toolName: "ast_grep_replace",
    toolCallId: "call-id",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    agentName: "orchestrator-agent",
    startedAt: Date.now(),
    allowedTools: new Set(["ast_grep_replace"]),
    workspaceRoot: "/workspace",
    projectContext: createTestProjectContext("/workspace"),
    ...overrides,
  };
}

function manager(binaryPath = "/managed/bin/ast-grep"): BinaryManager {
  return new BinaryManager({
    which: mock(() => binaryPath),
    exists: mock(() => false),
    isExecutable: mock(() => false),
    download: mock(() => Promise.reject(new Error("download should not run"))),
    verifySha256: mock(() => false),
    install: mock(() => Promise.reject(new Error("install should not run"))),
  });
}

function expectToolError(result: unknown, expected: { kind: ToolErrorKind; code: string; messageIncludes?: string }) {
  const r = result as ToolExecutionResult;
  expect(r.isError).toBe(true);
  expect(inferToolErrorKindFromResult(r)).toBe(expected.kind);
  const toolError = r.meta?.[TOOL_ERROR_META_KEY] as FormattedToolError | undefined;
  expect(toolError?.kind).toBe(expected.kind);
  expect(toolError?.code).toBe(expected.code);
  if (expected.messageIncludes) expect(r.output).toContain(expected.messageIncludes);
}

const replacementJson = JSON.stringify([
  {
    text: "console.log(message)",
    range: {
      byteOffset: { start: 10, end: 30 },
      start: { line: 1, column: 2 },
      end: { line: 1, column: 22 },
    },
    file: "src/app.ts",
    lines: "  console.log(message)",
    replacement: "logger.info(message)",
    replacementOffsets: { start: 10, end: 30 },
    metaVariables: { single: { MSG: { name: "MSG", text: "message" } }, multi: {}, transformed: {} },
  },
]);

describe("ast_grep_replace tool", () => {
  beforeEach(() => {
    setBinaryManagerForTest(manager());
    setProcessRunnerForTest(mock(() => spawnResult(replacementJson)));
  });

  afterEach(() => {
    setBinaryManagerForTest(undefined);
    setProcessRunnerForTest(undefined);
  });

  test("defines destructive non-read-only non-concurrency-safe traits", () => {
    expect(astGrepReplaceTool.name).toBe("ast_grep_replace");
    expect(astGrepReplaceTool.traits).toEqual({ readOnly: false, destructive: true, concurrencySafe: false });
    expect(astGrepReplaceTool.permissions?.length).toBeGreaterThan(0);
  });

  test("validates strict input schema and defaults dryRun to true", () => {
    const parsed = AstGrepReplaceInputSchema.safeParse({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Expected schema parse success");
    expect(parsed.data.dryRun).toBe(true);
    expect(astGrepReplaceTool.inputSchema.safeParse({ pattern: "x", rewrite: "y", dryRun: false, lang: "ts", paths: ["src"], globs: ["*.ts"] }).success).toBe(true);
    expect(astGrepReplaceTool.inputSchema.safeParse({ pattern: "x", rewrite: "y", unknown: true }).success).toBe(false);
    expect(astGrepReplaceTool.inputSchema.safeParse({ pattern: "x" }).success).toBe(false);
  });

  test("builds preview argv without update-all and keeps metasyntax as argv elements", () => {
    expect(buildAstGrepReplaceArgs({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: true, lang: "ts", globs: ["*.ts", "!*.test.ts"], paths: ["src"] })).toEqual([
      "run",
      "--pattern",
      "console.log($MSG)",
      "--rewrite",
      "logger.info($MSG)",
      "--json",
      "--lang",
      "ts",
      "--globs",
      "*.ts",
      "--globs",
      "!*.test.ts",
      "src",
    ]);
  });

  test("builds apply argv with update-all only when dryRun is false", () => {
    expect(buildAstGrepReplaceArgs({ pattern: "var $X = $Y", rewrite: "let $X = $Y", dryRun: false })).toEqual([
      "run",
      "--pattern",
      "var $X = $Y",
      "--rewrite",
      "let $X = $Y",
      "--update-all",
      "--json",
    ]);
  });

  test("preview mode resolves ast-grep through BinaryManager and omits update-all", async () => {
    let argv: readonly string[] = [];
    let cwd: string | undefined;
    setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]], options: { cwd?: string }) => { argv = cmd; cwd = options.cwd; return spawnResult(replacementJson); }));
    const result = await astGrepReplaceTool.execute({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: true, lang: "ts", paths: ["src"], globs: ["*.ts"] }, ctx());

    expect(argv).toEqual(["/managed/bin/ast-grep", "run", "--pattern", "console.log($MSG)", "--rewrite", "logger.info($MSG)", "--json", "--lang", "ts", "--globs", "*.ts", "src"]);
    expect(argv).not.toContain("--update-all");
    expect(cwd).toBe("/workspace");
    expect(typeof result).toBe("string");
  });

  test("preview mode returns proposed replacements without mutation flag", async () => {
    const result = await astGrepReplaceTool.execute({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: true }, ctx());
    expect(typeof result).toBe("string");
    if (typeof result !== "string") throw new Error("Expected string result");
    const parsed = JSON.parse(result) as { dryRun: boolean; applied: boolean; count: number; matches: Array<Record<string, unknown>> };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.applied).toBe(false);
    expect(parsed.count).toBe(1);
    expect(parsed.matches[0]).toMatchObject({
      file: "src/app.ts",
      text: "console.log(message)",
      lines: "  console.log(message)",
      replacement: "logger.info(message)",
      replacementOffsets: { start: 10, end: 30 },
      range: { byteOffset: { start: 10, end: 30 }, start: { line: 1, column: 2 }, end: { line: 1, column: 22 } },
    });
  });

  test("apply mode includes update-all and reports applied", async () => {
    let argv: readonly string[] = [];
    setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]]) => { argv = cmd; return spawnResult(replacementJson); }));
    const result = await astGrepReplaceTool.execute({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false }, ctx());

    expect(argv).toContain("--update-all");
    expect(typeof result).toBe("string");
    if (typeof result !== "string") throw new Error("Expected string result");
    expect(JSON.parse(result)).toMatchObject({ dryRun: false, applied: true, count: 1 });
  });

  test("treats exit code 1 as an empty result", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("", "", 1)));
    const result = await astGrepReplaceTool.execute({ pattern: "nope", rewrite: "replacement", dryRun: true }, ctx());
    expect(result).toBe(JSON.stringify({ dryRun: true, applied: false, count: 0, matches: [] }, null, 2));
  });

  test("surfaces ast-grep errors as typed ast-grep errors", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("", "Pattern parse error: unexpected token", 2)));
    const result = await astGrepReplaceTool.execute({ pattern: "console.log($MSG", rewrite: "logger.info($MSG)", dryRun: true }, ctx());
    expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: "Pattern parse error" });
    const toolError = (result as ToolExecutionResult).meta?.[TOOL_ERROR_META_KEY] as FormattedToolError;
    expect(toolError.name).toBe("AstGrepReplaceToolError");
  });

  test("surfaces invalid JSON output as ast-grep errors", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("not-json")));
    const result = await astGrepReplaceTool.execute({ pattern: "x", rewrite: "y", dryRun: true }, ctx());
    expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: "Failed to parse ast-grep JSON output" });
  });

  test("surfaces abort, signal, and spawn failures as ast-grep errors", async () => {
    const aborted = new AbortController();
    aborted.abort("cancelled");
    const cases = [
      { spawn: () => spawnResult(""), context: ctx({ abort: aborted.signal }), text: "aborted" },
      { spawn: () => spawnResult("", "", 143, "SIGTERM"), context: ctx(), text: "SIGTERM" },
      { spawn: () => { throw new Error("ENOENT"); }, context: ctx(), text: "ENOENT" },
    ];
    for (const item of cases) {
      setProcessRunnerForTest(mock(item.spawn));
      const result = await astGrepReplaceTool.execute({ pattern: "x", rewrite: "y", dryRun: true }, item.context);
      expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: item.text });
    }
  });

  test("checks workspace permission for every path with operation based on dryRun", async () => {
    const perm = astGrepReplaceTool.permissions![0];
    expect((await perm({ pattern: "x", rewrite: "y", paths: ["src"] }, ctx())).outcome).toBe("allow");

    const previewDecision = await perm({ pattern: "x", rewrite: "y", paths: ["../outside"] }, ctx());
    expect(previewDecision.outcome).toBe("ask");
    const previewScope = previewDecision.approval?.scope;
    expect(previewScope?.kind).toBe("file-path");
    if (previewScope?.kind !== "file-path") throw new Error("Expected file-path approval");
    expect(previewScope.operation).toBe("read");

    const applyDecision = await perm({ pattern: "x", rewrite: "y", dryRun: false, paths: ["../outside"] }, ctx());
    expect(applyDecision.outcome).toBe("ask");
    const applyScope = applyDecision.approval?.scope;
    expect(applyScope?.kind).toBe("file-path");
    if (applyScope?.kind !== "file-path") throw new Error("Expected file-path approval");
    expect(applyScope.operation).toBe("write");
  });
});
