import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { BinaryManager, setBinaryManagerForTest } from "../../../binary/manager";
import { setProcessRunnerForTest } from "../../../process/runner";
import { SkillService } from "../../../skills";
import { TOOL_ERROR_META_KEY, inferToolErrorKindFromResult } from "../../errors";
import { createTestProjectContext } from "../../test-project-context";
import type { FormattedToolError, ToolErrorKind } from "../../errors";
import type { ToolExecutionContext, ToolExecutionResult } from "../../types";
import { astGrepSearchTool, buildAstGrepSearchArgs } from "./search";

function stream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close(); } });
}

function spawnResult(stdout: string, stderr = "", exitCode = 0, signalCode?: string) {
  return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(exitCode), exitCode, signalCode, kill: mock(() => undefined) };
}

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    store: {} as any,
    toolName: "ast_grep_search",
    toolCallId: "call-id",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    agentName: "orchestrator-agent",
    startedAt: Date.now(),
    allowedTools: new Set(["ast_grep_search"]),
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

const sampleJson = JSON.stringify([{ text: "console.log(message)", range: { byteOffset: { start: 10, end: 30 }, start: { line: 1, column: 2 }, end: { line: 1, column: 22 } }, file: "src/app.ts", lines: "  console.log(message)", charCount: { leading: 2, trailing: 0 }, language: "TypeScript", metaVariables: { single: { MSG: { text: "message", range: { byteOffset: { start: 15, end: 22 }, start: { line: 1, column: 15 }, end: { line: 1, column: 22 } } } }, multi: {}, transformed: {} } }]);

describe("ast_grep_search tool", () => {
  beforeEach(() => {
    setBinaryManagerForTest(manager());
    setProcessRunnerForTest(mock(() => spawnResult(sampleJson)));
  });

  afterEach(() => {
    setBinaryManagerForTest(undefined);
    setProcessRunnerForTest(undefined);
  });

  test("defines read-only concurrency-safe traits", () => {
    expect(astGrepSearchTool.name).toBe("ast_grep_search");
    expect(astGrepSearchTool.traits).toEqual({ readOnly: true, destructive: false, concurrencySafe: true });
  });

  test("validates strict input schema", () => {
    expect(astGrepSearchTool.inputSchema.safeParse({ pattern: "console.log($MSG)" }).success).toBe(true);
    expect(astGrepSearchTool.inputSchema.safeParse({ pattern: "x", lang: "ts", paths: ["src"], globs: ["*.ts", "!*.test.ts"] }).success).toBe(true);
    expect(astGrepSearchTool.inputSchema.safeParse({ pattern: "x", unknown: true }).success).toBe(false);
  });

  test("builds argv with pattern as a single argv element", () => {
    expect(buildAstGrepSearchArgs({ pattern: "console.log($MSG)", lang: "ts", globs: ["*.ts", "!*.test.ts"], paths: ["src"] })).toEqual(["run", "--pattern", "console.log($MSG)", "--json", "--lang", "ts", "--globs", "*.ts", "--globs", "!*.test.ts", "src"]);
  });

  test("resolves ast-grep through BinaryManager and executes through ProcessRunner", async () => {
    let argv: readonly string[] = [];
    setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]]) => { argv = cmd; return spawnResult(sampleJson); }));
    await astGrepSearchTool.execute({ pattern: "console.log($MSG)", lang: "ts", paths: ["src"], globs: ["*.ts"] }, ctx());
    expect(argv).toEqual(["/managed/bin/ast-grep", "run", "--pattern", "console.log($MSG)", "--json", "--lang", "ts", "--globs", "*.ts", "src"]);
  });

  test("normalizes ast-grep JSON results", async () => {
    const result = await astGrepSearchTool.execute({ pattern: "console.log($MSG)" }, ctx());
    expect(typeof result).toBe("string");
    if (typeof result !== "string") throw new Error("Expected string result");
    const parsed = JSON.parse(result) as { count: number; matches: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(1);
    expect(parsed.matches[0]).toMatchObject({ file: "src/app.ts", text: "console.log(message)", lines: "  console.log(message)", range: { byteOffset: { start: 10, end: 30 }, start: { line: 1, column: 2 }, end: { line: 1, column: 22 } } });
    expect(parsed.matches[0]?.metaVariables).toEqual({ single: { MSG: { text: "message", range: { byteOffset: { start: 15, end: 22 }, start: { line: 1, column: 15 }, end: { line: 1, column: 22 } } } }, multi: {}, transformed: {} });
  });

  test("treats exit code 1 as an empty result", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("", "", 1)));
    const result = await astGrepSearchTool.execute({ pattern: "nope" }, ctx());
    expect(result).toBe(JSON.stringify({ count: 0, matches: [] }, null, 2));
  });

  test("treats exit code 1 with non-empty stdout as error (broken binary)", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("ast-grep shim file was executed...", "", 1)));
    const result = await astGrepSearchTool.execute({ pattern: "x" }, ctx());
    expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: "exited with code 1" });
  });

  test("treats exit code 1 with non-empty stderr as error", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("", "error: inaccessible files", 1)));
    const result = await astGrepSearchTool.execute({ pattern: "x" }, ctx());
    expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: "error: inaccessible files" });
  });

  test("surfaces invalid pattern errors as typed ast-grep errors", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("", "Pattern parse error: unexpected token", 2)));
    const result = await astGrepSearchTool.execute({ pattern: "console.log($MSG" }, ctx());
    expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: "Pattern parse error" });
    const toolError = (result as ToolExecutionResult).meta?.[TOOL_ERROR_META_KEY] as FormattedToolError;
    expect(toolError.name).toBe("AstGrepToolError");
  });

  test("surfaces invalid JSON output as ast-grep errors", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("not-json")));
    const result = await astGrepSearchTool.execute({ pattern: "x" }, ctx());
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
      const result = await astGrepSearchTool.execute({ pattern: "x" }, item.context);
      expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: item.text });
    }
  });

  test("checks workspace permission for every path", async () => {
    const perm = astGrepSearchTool.permissions![0];
    expect((await perm({ pattern: "x", paths: ["src"] }, ctx())).outcome).toBe("allow");
    const decision = await perm({ pattern: "x", paths: ["../outside"] }, ctx());
    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("outside");
  });
});
