import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BinaryManager, setBinaryManagerForTest } from "../../../binary/manager";
import { setProcessRunnerForTest } from "../../../process/runner";
import { SkillService } from "../../../skills";
import { createMockStore } from "../../../store/test-helpers";
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
    store: createMockStore(),
    toolName: "ast_grep_replace",
    toolCallId: "call-id",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    agentName: "orchestrator-agent",
    startedAt: Date.now(),
    allowedTools: new Set(["ast_grep_replace"]),
    agentSkills: [],
    skillService: new SkillService({ builtinSkills: {} }),
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
    validateBinary: mock(() => Promise.resolve(true)),
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
    metaVariables: { single: { MSG: { text: "message", range: { byteOffset: { start: 15, end: 22 }, start: { line: 1, column: 15 }, end: { line: 1, column: 22 } } } }, multi: {}, transformed: {} },
  },
]);

function replacementJsonFor(file: string): string {
  return JSON.stringify([
    {
      text: "console.log(message)",
      range: {
        byteOffset: { start: 10, end: 30 },
        start: { line: 1, column: 2 },
        end: { line: 1, column: 22 },
      },
      file,
      lines: "  console.log(message)",
      replacement: "logger.info(message)",
      replacementOffsets: { start: 10, end: 30 },
    },
  ]);
}

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "ast-grep-replace-workspace-"));
}

function createSnapshotStore(file: string, mtime = statSync(realpathSync.native(file)).mtimeMs) {
  return createMockStore({ readSnapshots: new Map([[realpathSync.native(file), mtime]]) });
}

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
    const workspace = tempWorkspace();
    let argv: readonly string[] = [];
    try {
      const file = join(workspace, "src-app.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]]) => { argv = cmd; return spawnResult(replacementJsonFor("src-app.ts")); }));
      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({ workspaceRoot: workspace, projectContext: createTestProjectContext(workspace), store: createSnapshotStore(file) }),
      );

      expect(argv).toContain("--update-all");
      expect(typeof result).toBe("string");
      if (typeof result !== "string") throw new Error("Expected string result");
      expect(JSON.parse(result)).toMatchObject({ dryRun: false, applied: true, count: 1 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode first previews and returns read-before-write when target was not read", async () => {
    const workspace = tempWorkspace();
    try {
      const file = join(workspace, "unread.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      const run = mock((cmd: readonly [string, ...string[]]) => { void cmd; return spawnResult(replacementJsonFor("unread.ts")); });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({ workspaceRoot: workspace, projectContext: createTestProjectContext(workspace), store: createMockStore() }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).not.toContain("--update-all");
      expectToolError(result, { kind: "read-before-write", code: "TOOL_FILE_NOT_READ_FIRST", messageIncludes: "has not been read first" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode returns write-conflict when target mtime changed since snapshot", async () => {
    const workspace = tempWorkspace();
    try {
      const file = join(workspace, "conflict.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      const run = mock((cmd: readonly [string, ...string[]]) => { void cmd; return spawnResult(replacementJsonFor("conflict.ts")); });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({ workspaceRoot: workspace, projectContext: createTestProjectContext(workspace), store: createSnapshotStore(file, 12345) }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).not.toContain("--update-all");
      expectToolError(result, { kind: "write-conflict", code: "TOOL_FILE_WRITE_CONFLICT", messageIncludes: "modified since it was read" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode succeeds after preview when target snapshot mtime matches", async () => {
    const workspace = tempWorkspace();
    try {
      const file = join(workspace, "success.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      const run = mock((cmd: readonly [string, ...string[]]) => { void cmd; return spawnResult(replacementJsonFor("success.ts")); });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({ workspaceRoot: workspace, projectContext: createTestProjectContext(workspace), store: createSnapshotStore(file) }),
      );

      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[0]?.[0]).not.toContain("--update-all");
      expect(run.mock.calls[1]?.[0]).toContain("--update-all");
      expect(typeof result).toBe("string");
      if (typeof result !== "string") throw new Error("Expected string result");
      expect(JSON.parse(result)).toMatchObject({ dryRun: false, applied: true, count: 1 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("treats exit code 1 as an empty result", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("", "", 1)));
    const result = await astGrepReplaceTool.execute({ pattern: "nope", rewrite: "replacement", dryRun: true }, ctx());
    expect(result).toBe(JSON.stringify({ dryRun: true, applied: false, count: 0, matches: [] }, null, 2));
  });

  test("treats exit code 1 with non-empty stdout as error (broken binary)", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("ast-grep shim file was executed...", "", 1)));
    const result = await astGrepReplaceTool.execute({ pattern: "x", rewrite: "y", dryRun: true }, ctx());
    expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: "exited with code 1" });
  });

  test("treats exit code 1 with non-empty stderr as error", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("", "error: inaccessible files", 1)));
    const result = await astGrepReplaceTool.execute({ pattern: "x", rewrite: "y", dryRun: true }, ctx());
    expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: "error: inaccessible files" });
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
