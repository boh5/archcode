import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { storeManager } from "../../../store/store";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BinaryManager, setBinaryManagerForTest } from "../../../binary/manager";
import { setProcessRunnerForTest } from "../../../process/runner";
import { SkillService } from "../../../skills";
import { createMockStore } from "../../../store/test-helpers";
import { inferToolErrorKindFromResult } from "../../errors";
import { createTestProjectContext } from "../../test-project-context";
import type { ToolErrorKind } from "../../errors";
import type { RawToolResult, ToolExecutionContext } from "../../types";
import { AstGrepReplaceInputSchema, astGrepReplaceTool, buildAstGrepReplaceArgs } from "./replace";

function stream(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close(); } });
}

function spawnResult(stdout: string, stderr = "", exitCode = 0, signalCode?: string) {
  return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(exitCode), exitCode, signalCode, kill: mock(() => undefined) };
}

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return { store: createMockStore(),
  toolName: "ast_grep_replace",
  toolCallId: "call-id",
  input: {},
  step: 1,
  abort: new AbortController().signal,
  agentName: "lead-agent",
  startedAt: Date.now(),
  allowedTools: new Set(["ast_grep_replace"]),
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

function diffPresentation(result: RawToolResult) {
  const presentation = result.details?.presentations?.find((item) => item.kind === "diff");
  return presentation?.kind === "diff" ? presentation : undefined;
}

const replacementRecord = {
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
  };
const replacementJson = `${JSON.stringify(replacementRecord)}\n`;

function replacementJsonFor(file: string): string {
  return `${JSON.stringify({
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
    })}\n`;
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
      "--json=stream",
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
      "--json=stream",
    ]);
  });

  test("preview mode resolves ast-grep through BinaryManager and omits update-all", async () => {
    let argv: readonly string[] = [];
    let cwd: string | undefined;
    setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]], options: { cwd?: string }) => { argv = cmd; cwd = options.cwd; return spawnResult(replacementJson); }));
    const result = await astGrepReplaceTool.execute({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: true, lang: "ts", paths: ["src"], globs: ["*.ts"] }, ctx());

    expect(argv).toEqual(["/managed/bin/ast-grep", "run", "--pattern", "console.log($MSG)", "--rewrite", "logger.info($MSG)", "--json=stream", "--lang", "ts", "--globs", "*.ts", "src"]);
    expect(argv).not.toContain("--update-all");
    expect(cwd).toBe("/workspace");
    expect(result.draft.kind).toBe("text");
  });

  test("preview mode returns canonical replacement NDJSON", async () => {
    const result = await astGrepReplaceTool.execute({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: true }, ctx());
    const parsed = JSON.parse(draftText(result).trim()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      file: "src/app.ts",
      text: "console.log(message)",
      lines: "  console.log(message)",
      replacement: "logger.info(message)",
      replacementOffsets: { start: 10, end: 30 },
      range: { byteOffset: { start: 10, end: 30 }, start: { line: 1, column: 2 }, end: { line: 1, column: 22 } },
    });
  });

  test("preview mode does not attach applied diff metadata", async () => {
    const result = await astGrepReplaceTool.execute({ pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: true }, ctx());
    expect(result.draft.kind).toBe("text");
    expect(result.details?.presentations).toBeUndefined();
  });

  test("apply mode includes update-all and reports applied", async () => {
    const workspace = tempWorkspace();
    let argv: readonly string[] = [];
    try {
      const file = join(workspace, "src-app.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]]) => {
        argv = cmd;
        if (cmd.includes("--update-all")) writeFileSync(file, "logger.info(message)", "utf-8");
        return spawnResult(replacementJsonFor("src-app.ts"));
      }));
      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({ cwd: workspace, projectContext: createTestProjectContext(workspace), store: createSnapshotStore(file) }),
      );

      expect(argv).toContain("--update-all");
      expect(JSON.parse(draftText(result).trim())).toMatchObject({ file: "src-app.ts", replacement: "logger.info(message)" });
      expect(diffPresentation(result)).toMatchObject({
        kind: "diff",
        files: [
          {
            path: "src-app.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode captures only the final canonical stream, not its internal preview", async () => {
    const workspace = tempWorkspace();
    let capturedBytes = 0;
    try {
      const file = join(workspace, "captured.ts");
      const canonical = replacementJsonFor("captured.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]]) => {
        if (cmd.includes("--update-all")) writeFileSync(file, "logger.info(message)", "utf-8");
        return spawnResult(canonical);
      }));

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({
          cwd: workspace,
          projectContext: createTestProjectContext(workspace),
          store: createSnapshotStore(file),
          outputCapture: {
            write: mock(async (chunk: string | Uint8Array) => {
              capturedBytes += typeof chunk === "string" ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength;
              return "accepted" as const;
            }),
          } as any,
        }),
      );

      expect(result.draft.kind).toBe("capture");
      expect(capturedBytes).toBe(new TextEncoder().encode(canonical).byteLength);
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
        ctx({ cwd: workspace, projectContext: createTestProjectContext(workspace), store: createMockStore() }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).not.toContain("--update-all");
      expectToolError(result, { kind: "read-before-write", code: "TOOL_FILE_NOT_READ_FIRST", messageIncludes: "has not been read first" });
      expect(result.details?.presentations).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode refuses preview matches under .archcode before mutation", async () => {
    const workspace = tempWorkspace();
    try {
      const artifact = join(workspace, ".archcode", "goals", "00000000-0000-0000-0000-000000000001", "goal.json");
      mkdirSync(join(workspace, ".archcode", "goals", "00000000-0000-0000-0000-000000000001"), { recursive: true });
      writeFileSync(artifact, "console.log(message)", "utf-8");
      const run = mock((cmd: readonly [string, ...string[]]) => { void cmd; return spawnResult(replacementJsonFor(".archcode/goals/00000000-0000-0000-0000-000000000001/goal.json")); });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({ cwd: workspace, projectContext: createTestProjectContext(workspace), store: createSnapshotStore(artifact) }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).not.toContain("--update-all");
      expectToolError(result, { kind: "permission-denied", code: "PROTECTED_PATH_WRITE_DENIED", messageIncludes: "system-managed .archcode path" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode refuses preview matches under canonical project state from a worktree Session", async () => {
    const projectRoot = tempWorkspace();
    const worktree = tempWorkspace();
    try {
      const artifact = join(projectRoot, ".archcode", "memory", "index.md");
      mkdirSync(join(projectRoot, ".archcode", "memory"), { recursive: true });
      writeFileSync(artifact, "console.log(message)", "utf-8");
      const run = mock((cmd: readonly [string, ...string[]]) => {
        void cmd;
        return spawnResult(replacementJsonFor(artifact));
      });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({
          cwd: worktree,
          projectContext: createTestProjectContext(projectRoot),
          store: createSnapshotStore(artifact),
        }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).not.toContain("--update-all");
      expectToolError(result, {
        kind: "permission-denied",
        code: "PROTECTED_PATH_WRITE_DENIED",
        messageIncludes: "system-managed .archcode path",
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("apply mode refuses preview matches that reach canonical project state through a worktree symlink", async () => {
    const projectRoot = tempWorkspace();
    const worktree = tempWorkspace();
    try {
      const artifact = join(projectRoot, ".archcode", "memory", "index.md");
      mkdirSync(join(projectRoot, ".archcode", "memory"), { recursive: true });
      writeFileSync(artifact, "console.log(message)", "utf-8");
      symlinkSync(join(projectRoot, ".archcode"), join(worktree, "canonical-state"));
      const run = mock((cmd: readonly [string, ...string[]]) => {
        void cmd;
        return spawnResult(replacementJsonFor("canonical-state/memory/index.md"));
      });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({
          cwd: worktree,
          projectContext: createTestProjectContext(projectRoot),
          store: createSnapshotStore(artifact),
        }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expectToolError(result, {
        kind: "permission-denied",
        code: "PROTECTED_PATH_WRITE_DENIED",
        messageIncludes: "system-managed .archcode path",
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("apply mode rechecks protected project state under the lock before mutation", async () => {
    const projectRoot = tempWorkspace();
    const worktree = tempWorkspace();
    try {
      const sourceFile = join(worktree, "source.ts");
      const artifact = join(projectRoot, ".archcode", "memory", "index.md");
      writeFileSync(sourceFile, "console.log(message)", "utf-8");
      mkdirSync(join(projectRoot, ".archcode", "memory"), { recursive: true });
      writeFileSync(artifact, "console.log(message)", "utf-8");
      let callCount = 0;
      const run = mock((cmd: readonly [string, ...string[]]) => {
        void cmd;
        callCount++;
        return spawnResult(replacementJsonFor(callCount === 1 ? "source.ts" : artifact));
      });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({
          cwd: worktree,
          projectContext: createTestProjectContext(projectRoot),
          store: createSnapshotStore(sourceFile),
        }),
      );

      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[0]).not.toContain("--update-all");
      expectToolError(result, {
        kind: "permission-denied",
        code: "PROTECTED_PATH_WRITE_DENIED",
        messageIncludes: "system-managed .archcode path",
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
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
        ctx({ cwd: workspace, projectContext: createTestProjectContext(workspace), store: createSnapshotStore(file, 12345) }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).not.toContain("--update-all");
      expectToolError(result, { kind: "write-conflict", code: "TOOL_FILE_WRITE_CONFLICT", messageIncludes: "modified since it was read" });
      expect(result.details?.presentations).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode returns file-not-found without diff metadata when target disappears before apply", async () => {
    const workspace = tempWorkspace();
    try {
      const file = join(workspace, "deleted.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      const store = createSnapshotStore(file);
      rmSync(file);
      const run = mock((cmd: readonly [string, ...string[]]) => { void cmd; return spawnResult(replacementJsonFor("deleted.ts")); });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({ cwd: workspace, projectContext: createTestProjectContext(workspace), store }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).not.toContain("--update-all");
      expectToolError(result, { kind: "file-not-found", code: "TOOL_FILE_NOT_FOUND", messageIncludes: "no longer exists" });
      expect(result.details?.presentations).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode succeeds after preview when target snapshot mtime matches", async () => {
    const workspace = tempWorkspace();
    try {
      const file = join(workspace, "success.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      const run = mock((cmd: readonly [string, ...string[]]) => {
        if (cmd.includes("--update-all")) writeFileSync(file, "logger.info(message)", "utf-8");
        return spawnResult(replacementJsonFor("success.ts"));
      });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({ cwd: workspace, projectContext: createTestProjectContext(workspace), store: createSnapshotStore(file) }),
      );

      expect(run).toHaveBeenCalledTimes(3);
      expect(run.mock.calls[0]?.[0]).not.toContain("--update-all");
      expect(run.mock.calls[1]?.[0]).not.toContain("--update-all");
      expect(run.mock.calls[2]?.[0]).toContain("--update-all");
      expect(JSON.parse(draftText(result).trim())).toMatchObject({ replacement: "logger.info(message)" });
      const diffs = diffPresentation(result);
      expect(diffs?.files?.[0]).toMatchObject({ path: "success.ts", status: "modified" });
      expect(diffs?.files?.[0]?.hunks?.length).toBeGreaterThan(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode with no actual file changes returns no-change diff metadata", async () => {
    const workspace = tempWorkspace();
    try {
      const file = join(workspace, "unchanged.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      const run = mock((cmd: readonly [string, ...string[]]) => { void cmd; return spawnResult(replacementJsonFor("unchanged.ts")); });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "console.log($MSG)", rewrite: "logger.info($MSG)", dryRun: false },
        ctx({ cwd: workspace, projectContext: createTestProjectContext(workspace), store: createSnapshotStore(file) }),
      );

      expect(run).toHaveBeenCalledTimes(3);
      expect(JSON.parse(draftText(result).trim())).toMatchObject({ replacement: "logger.info(message)" });
      expect(diffPresentation(result)).toEqual({ kind: "diff", files: [] });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode with empty matches stays output-only without diff metadata", async () => {
    const workspace = tempWorkspace();
    try {
      const run = mock((cmd: readonly [string, ...string[]]) => { void cmd; return spawnResult(""); });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "nope", rewrite: "replacement", dryRun: false },
        ctx({ cwd: workspace, projectContext: createTestProjectContext(workspace), store: createMockStore() }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(draftText(result)).toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("fails before mutation when preview exceeds the match cap", async () => {
    const record = replacementJsonFor("target.ts");
    const run = mock((cmd: readonly [string, ...string[]]) => {
      expect(cmd).not.toContain("--update-all");
      return spawnResult(record.repeat(10_001));
    });
    setProcessRunnerForTest(run);

    const result = await astGrepReplaceTool.execute(
      { pattern: "x", rewrite: "y", dryRun: false },
      ctx(),
    );

    expect(run).toHaveBeenCalledTimes(1);
    expectToolError(result, {
      kind: "ast-grep-error",
      code: "TOOL_AST_GREP_ERROR",
      messageIncludes: "exceeds 10000 matches",
    });
  });

  test("fails before mutation when preview exceeds the unique-file cap", async () => {
    const output = Array.from({ length: 1_001 }, (_, index) => replacementJsonFor(`file-${index}.ts`)).join("");
    const run = mock((cmd: readonly [string, ...string[]]) => {
      expect(cmd).not.toContain("--update-all");
      return spawnResult(output);
    });
    setProcessRunnerForTest(run);

    const result = await astGrepReplaceTool.execute(
      { pattern: "x", rewrite: "y", dryRun: false },
      ctx(),
    );

    expect(run).toHaveBeenCalledTimes(1);
    expectToolError(result, {
      kind: "ast-grep-error",
      code: "TOOL_AST_GREP_ERROR",
      messageIncludes: "exceeds 1000 unique files",
    });
  });

  test("fails before mutation when preview exceeds the aggregate path cap", async () => {
    const output = Array.from({ length: 1_000 }, (_, index) => replacementJsonFor(`${"x".repeat(4_200)}-${index}`)).join("");
    const run = mock((cmd: readonly [string, ...string[]]) => {
      expect(cmd).not.toContain("--update-all");
      return spawnResult(output);
    });
    setProcessRunnerForTest(run);

    const result = await astGrepReplaceTool.execute(
      { pattern: "x", rewrite: "y", dryRun: false },
      ctx(),
    );

    expect(run).toHaveBeenCalledTimes(1);
    expectToolError(result, {
      kind: "ast-grep-error",
      code: "TOOL_AST_GREP_ERROR",
      messageIncludes: "paths exceed 4194304 bytes",
    });
  });

  test("fails before mutation when one preview record exceeds 1 MiB", async () => {
    let mutations = 0;
    const oversized = `${JSON.stringify({ file: "target.ts", text: "x".repeat(1024 * 1024) })}\n`;
    const run = mock((cmd: readonly [string, ...string[]]) => {
      if (cmd.includes("--update-all")) mutations += 1;
      return spawnResult(oversized);
    });
    setProcessRunnerForTest(run);

    const result = await astGrepReplaceTool.execute(
      { pattern: "x", rewrite: "y", dryRun: false },
      ctx(),
    );

    expect(mutations).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expectToolError(result, {
      kind: "ast-grep-error",
      code: "TOOL_AST_GREP_ERROR",
      messageIncludes: "record exceeds 1048576 bytes",
    });
  });

  test("revalidates match thresholds under the mutation lock before apply", async () => {
    const workspace = tempWorkspace();
    try {
      const file = join(workspace, "locked.ts");
      writeFileSync(file, "console.log(message)", "utf-8");
      let calls = 0;
      let mutations = 0;
      const record = replacementJsonFor("locked.ts");
      const run = mock((cmd: readonly [string, ...string[]]) => {
        calls += 1;
        if (cmd.includes("--update-all")) mutations += 1;
        return spawnResult(calls === 1 ? record : record.repeat(10_001));
      });
      setProcessRunnerForTest(run);

      const result = await astGrepReplaceTool.execute(
        { pattern: "x", rewrite: "y", dryRun: false },
        ctx({ cwd: workspace, projectContext: createTestProjectContext(workspace), store: createSnapshotStore(file) }),
      );

      expect(calls).toBe(2);
      expect(mutations).toBe(0);
      expectToolError(result, {
        kind: "ast-grep-error",
        code: "TOOL_AST_GREP_ERROR",
        messageIncludes: "exceeds 10000 matches",
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("treats exit code 1 as an empty result", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("", "", 1)));
    const result = await astGrepReplaceTool.execute({ pattern: "nope", rewrite: "replacement", dryRun: true }, ctx());
    expect(draftText(result)).toBe("");
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
    expect(result.details?.error?.name).toBe("AstGrepReplaceToolError");
  });

  test("surfaces invalid JSON output as ast-grep errors", async () => {
    setProcessRunnerForTest(mock(() => spawnResult("not-json")));
    const result = await astGrepReplaceTool.execute({ pattern: "x", rewrite: "y", dryRun: true }, ctx());
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

  test("checks protected .archcode permission for explicit paths", async () => {
    const protectedPermission = astGrepReplaceTool.permissions![1];

    const decision = await protectedPermission({ pattern: "x", rewrite: "y", dryRun: false, paths: [".archcode/goals/goal_test/goal.json"] }, ctx());

    expect(decision.outcome).toBe("deny");
    expect(decision.errorCode).toBe("PROTECTED_PATH_WRITE_DENIED");
  });

  test("checks canonical project .archcode permission for explicit paths from a worktree Session", async () => {
    const protectedPermission = astGrepReplaceTool.permissions![1];
    const projectRoot = "/canonical/project";
    const decision = await protectedPermission(
      {
        pattern: "x",
        rewrite: "y",
        dryRun: false,
        paths: [join(projectRoot, ".archcode", "memory")],
      },
      ctx({
        cwd: "/worktrees/session-1",
        projectContext: createTestProjectContext(projectRoot),
      }),
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.errorCode).toBe("PROTECTED_PATH_WRITE_DENIED");
  });
});
