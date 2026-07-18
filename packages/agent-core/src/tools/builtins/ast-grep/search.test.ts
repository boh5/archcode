import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { storeManager } from "../../../store/store";

import { BinaryManager, setBinaryManagerForTest } from "../../../binary/manager";
import { setProcessRunnerForTest } from "../../../process/runner";
import { SkillService } from "../../../skills";
import { inferToolErrorKindFromResult } from "../../errors";
import { createTestProjectContext } from "../../test-project-context";
import type { ToolErrorKind } from "../../errors";
import type { RawToolResult, ToolExecutionContext } from "../../types";
import { astGrepSearchTool, buildAstGrepSearchArgs } from "./search";

function stream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close(); } });
}

function spawnResult(stdout: string, stderr = "", exitCode = 0, signalCode?: string) {
  return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(exitCode), exitCode, signalCode, kill: mock(() => undefined) };
}

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return { store: {} as any,
  toolName: "ast_grep_search",
  toolCallId: "call-id",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  agentName: "engineer-agent",
  startedAt: Date.now(),
  allowedTools: new Set(["ast_grep_search"]),
  agentSkills: [],
  skillService: new SkillService({ builtinSkills: {} }),
  cwd: "/workspace",
  storeManager,
    projectContext: createTestProjectContext("/workspace"), ...overrides,  };
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
  const r = result as RawToolResult;
  expect(r.isError).toBe(true);
  expect(inferToolErrorKindFromResult(r)).toBe(expected.kind);
  expect(r.details?.error?.kind).toBe(expected.kind);
  expect(r.details?.error?.code).toBe(expected.code);
  if (expected.messageIncludes) expect(draftText(r)).toContain(expected.messageIncludes);
}

function draftText(result: RawToolResult): string {
  if (result.draft.kind !== "text") throw new Error(`Expected text draft, got ${result.draft.kind}`);
  return result.draft.text;
}

const sampleRecord = { text: "console.log(message)", range: { byteOffset: { start: 10, end: 30 }, start: { line: 1, column: 2 }, end: { line: 1, column: 22 } }, file: "src/app.ts", lines: "  console.log(message)", charCount: { leading: 2, trailing: 0 }, language: "TypeScript", metaVariables: { single: { MSG: { text: "message", range: { byteOffset: { start: 15, end: 22 }, start: { line: 1, column: 15 }, end: { line: 1, column: 22 } } } }, multi: {}, transformed: {} } };
const sampleJson = `${JSON.stringify(sampleRecord)}\n`;

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
    expect(buildAstGrepSearchArgs({ pattern: "console.log($MSG)", lang: "ts", globs: ["*.ts", "!*.test.ts"], paths: ["src"] })).toEqual(["run", "--pattern", "console.log($MSG)", "--json=stream", "--lang", "ts", "--globs", "*.ts", "--globs", "!*.test.ts", "src"]);
  });

  test("resolves ast-grep through BinaryManager and executes through ProcessRunner", async () => {
    let argv: readonly string[] = [];
    setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]]) => { argv = cmd; return spawnResult(sampleJson); }));
    await astGrepSearchTool.execute({ pattern: "console.log($MSG)", lang: "ts", paths: ["src"], globs: ["*.ts"] }, ctx());
    expect(argv).toEqual(["/managed/bin/ast-grep", "run", "--pattern", "console.log($MSG)", "--json=stream", "--lang", "ts", "--globs", "*.ts", "src"]);
  });

  test("runs from execution cwd instead of the canonical project root", async () => {
    const executionCwd = "/worktrees/session-ast";
    let spawnedCwd: string | undefined;
    setProcessRunnerForTest(mock((_argv: unknown, options: { cwd?: string }) => {
      spawnedCwd = options.cwd;
      return spawnResult(sampleJson);
    }) as NonNullable<Parameters<typeof setProcessRunnerForTest>[0]>);

    await astGrepSearchTool.execute({ pattern: "console.log($MSG)" }, ctx({
      cwd: executionCwd,
      projectContext: createTestProjectContext("/canonical/project"),
    }));

    expect(spawnedCwd).toBe(executionCwd);
  });

  test("returns ast-grep canonical NDJSON", async () => {
    const result = await astGrepSearchTool.execute({ pattern: "console.log($MSG)" }, ctx());
    expect(draftText(result)).toBe(sampleJson);
    expect(JSON.parse(draftText(result).trim())).toEqual(sampleRecord);
  });

  test("streams canonical NDJSON beyond the retained process preview into registry capture", async () => {
    const canonical = sampleJson.repeat(12_000);
    let capturedBytes = 0;
    setProcessRunnerForTest(mock(() => spawnResult(canonical)));

    const result = await astGrepSearchTool.execute(
      { pattern: "console.log($MSG)" },
      ctx({
        outputCapture: {
          write: mock(async (chunk: string | Uint8Array) => {
            capturedBytes += typeof chunk === "string" ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength;
            return "accepted" as const;
          }),
        } as any,
      }),
    );

    expect(new TextEncoder().encode(canonical).byteLength).toBeGreaterThan(1024 * 1024);
    expect(result).toEqual({ isError: false, draft: { kind: "capture" } });
    expect(capturedBytes).toBe(new TextEncoder().encode(canonical).byteLength);
  });

  test("treats exit code 1 as an empty result", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("", "", 1)));
    const result = await astGrepSearchTool.execute({ pattern: "nope" }, ctx());
    expect(draftText(result)).toBe("");
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
    expect(result.details?.error?.name).toBe("AstGrepToolError");
  });

  test("surfaces invalid JSON output as ast-grep errors", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("not-json")));
    const result = await astGrepSearchTool.execute({ pattern: "x" }, ctx());
    expectToolError(result, { kind: "ast-grep-error", code: "TOOL_AST_GREP_ERROR", messageIncludes: "Failed to parse ast-grep JSON stream record" });
  });

  test("surfaces abort, signal, and spawn failures as ast-grep errors", async () => {
    const aborted = new AbortController();
    aborted.abort("cancelled");
    const cases = [
      { spawn: () => spawnResult(""), context: ctx({ abort: aborted.signal }), text: "aborted" },
      { spawn: () => spawnResult("", "", 143, "SIGTERM"), context: ctx(), text: "SIGTERM" },
      { spawn: () => { throw new Error("ENOENT"); }, context: ctx(), text: "Process failed to start" },
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
