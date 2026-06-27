import { statSync } from "node:fs";
import { z } from "zod";

import { createBinaryManager } from "../../../binary/manager";
import { createProcessRunner } from "../../../process/runner";
import type { ProcessRunnerResult } from "../../../process/types";
import { sharedMutationQueue } from "../../concurrency/mutation-queue";
import { defineTool } from "../../define-tool";
import { computeToolDiffs } from "../../diff";
import { createToolErrorResult } from "../../errors";
import { createPostEditDiagnosticsHook } from "../../hooks";
import { createProtectedPathPermission, isProtectedProjectPath } from "../../permission";
import { resolveAndValidatePath } from "../../security";
import type { PermissionDecision, ToolExecutionContext, ToolExecutionResult, ToolPermission } from "../../types";

export const AstGrepReplaceInputSchema = z
  .object({
    pattern: z.string().min(1).describe("ast-grep pattern with meta-variables ($VAR, $$$) to match. Must be a complete AST node."),
    rewrite: z.string().min(1).describe("Replacement pattern. Use $VAR from the pattern to preserve matched content. Can use literal text."),
    lang: z.string().min(1).optional().describe("Target language. See ast_grep_search lang param for supported values."),
    paths: z.array(z.string().min(1)).optional().describe("Directories or files to search in (absolute or workspace-relative). Defaults to workspace root."),
    globs: z.array(z.string().min(1)).optional().describe("Include/exclude glob patterns. Prefix ! to exclude."),
    dryRun: z.boolean().default(true).describe("true = preview only, no files written. false = apply changes to disk. Default true."),
  })
  .strict();

const AstGrepRangePositionSchema = z
  .object({
    line: z.number(),
    column: z.number(),
  })
  .passthrough();

const AstGrepRangeSchema = z
  .object({
    byteOffset: z
      .object({
        start: z.number(),
        end: z.number(),
      })
      .passthrough(),
    start: AstGrepRangePositionSchema,
    end: AstGrepRangePositionSchema,
  })
  .passthrough();

/** ast-grep outputs { text, range } where the record key IS the variable name */
const AstGrepMatchNodeSchema = z
  .object({
    text: z.string(),
    range: AstGrepRangeSchema.optional(),
  })
  .passthrough();

const AstGrepReplacementMatchSchema = z
  .object({
    text: z.string(),
    range: AstGrepRangeSchema,
    file: z.string(),
    lines: z.string(),
    /** ast-grep v0.42+ outputs charCount for context character counts */
    charCount: z
      .object({
        leading: z.number(),
        trailing: z.number(),
      })
      .passthrough()
      .optional(),
    /** ast-grep v0.42+ outputs the matched language */
    language: z.string().optional(),
    replacement: z.string().optional(),
    replacementOffsets: z
      .object({
        start: z.number(),
        end: z.number(),
      })
      .passthrough()
      .optional(),
    metaVariables: z
      .object({
        single: z.record(z.string(), AstGrepMatchNodeSchema).optional(),
        multi: z.record(z.string(), z.array(AstGrepMatchNodeSchema)).optional(),
        transformed: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const AstGrepReplacementMatchesSchema = z.array(AstGrepReplacementMatchSchema);

type AstGrepReplaceInput = z.infer<typeof AstGrepReplaceInputSchema>;
type AstGrepReplacementMatch = z.infer<typeof AstGrepReplacementMatchSchema>;

export class AstGrepReplaceToolError extends Error {
  readonly exitCode?: number;

  constructor(message: string, params: { exitCode?: number; cause?: unknown } = {}) {
    super(message, { cause: params.cause });
    this.name = "AstGrepReplaceToolError";
    this.exitCode = params.exitCode;
  }
}

export const astGrepReplaceTool = defineTool({
  name: "ast_grep_replace",
  description:
    "Preview or apply structural code rewrites using ast-grep. Defaults to dryRun preview; set dryRun false to apply changes.",
  inputSchema: AstGrepReplaceInputSchema,
  traits: {
    readOnly: false,
    destructive: true,
    concurrencySafe: false,
  },
  permissions: [createAstGrepReplaceWorkspacePermission(), createProtectedPathPermission()],
  hooks: { after: [createPostEditDiagnosticsHook({ inputPathKeys: [] })] },
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    try {
      const astGrepPath = await createBinaryManager().resolve("ast-grep");
      const runner = createProcessRunner();
      let matches: AstGrepReplacementMatch[];

      if (input.dryRun === false) {
        const previewResult = await runAstGrepReplace(astGrepPath, { ...input, dryRun: true }, ctx, runner);
        if ("isError" in previewResult) return previewResult;
        matches = previewResult;

        const protectedProtectedCheck = checkApplyProtectedPath(matches, ctx);
        if (protectedProtectedCheck) return protectedProtectedCheck;

        const snapshotCheck = checkApplyReadSnapshots(matches, ctx);
        if (snapshotCheck) return snapshotCheck;

        return await withApplyTargetQueues(matches, ctx, async () => {
          const beforeFiles = await captureApplyFileContents(matches, ctx);
          const applyResult = await runAstGrepReplace(astGrepPath, input, ctx, runner);
          if ("isError" in applyResult) return applyResult;
          matches = applyResult;

          const output = JSON.stringify(normalizeAstGrepReplaceResult(matches, input.dryRun), null, 2);
          const diffs = await computeApplyDiffs(beforeFiles);
          return diffs ? { output, isError: false, meta: { diffs } } : output;
        });
      } else {
        const previewResult = await runAstGrepReplace(astGrepPath, input, ctx, runner);
        if ("isError" in previewResult) return previewResult;
        matches = previewResult;
      }

      return JSON.stringify(normalizeAstGrepReplaceResult(matches, input.dryRun), null, 2);
    } catch (error) {
      const maybeBinaryError = toBinaryToolError(error);
      if (maybeBinaryError) return maybeBinaryError;

      return createAstGrepReplaceErrorResult({
        error: error instanceof Error ? error : new Error(String(error)),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

async function runAstGrepReplace(
  astGrepPath: string,
  input: AstGrepReplaceInput,
  ctx: ToolExecutionContext,
  runner: ReturnType<typeof createProcessRunner>,
): Promise<AstGrepReplacementMatch[] | ToolExecutionResult> {
  const result = await runner.run({
    argv: [astGrepPath, ...buildAstGrepReplaceArgs(input)],
    cwd: ctx.workspaceRoot,
    env: { ...process.env },
    signal: ctx.abort,
  });

  const output = getAstGrepReplaceStdout(result);
  if (output.ok === false) return output.error;

  return parseAstGrepReplacementMatches(output.stdout);
}

function checkApplyProtectedPath(
  matches: AstGrepReplacementMatch[],
  ctx: ToolExecutionContext,
): ToolExecutionResult | undefined {
  const protectedMatch = matches.find((match) => isProtectedProjectPath(match.file, ctx.workspaceRoot));
  if (!protectedMatch) return undefined;

  return createToolErrorResult({
    kind: "permission-denied",
    code: "PROTECTED_PATH_WRITE_DENIED",
    message:
      `Cannot apply ast-grep replacement to system-managed .archcode path "${protectedMatch.file}". ` +
      "Use the appropriate workflow or memory tool instead.",
  });
}

function checkApplyReadSnapshots(
  matches: AstGrepReplacementMatch[],
  ctx: ToolExecutionContext,
): ToolExecutionResult | undefined {
  const snapshots = ctx.store.getState().readSnapshots;
  const files = new Set(matches.map((match) => match.file));

  for (const file of files) {
    const { resolved } = resolveAndValidatePath(file, ctx.workspaceRoot);
    if (!snapshots.has(resolved)) {
      return createToolErrorResult({
        kind: "read-before-write",
        code: "TOOL_FILE_NOT_READ_FIRST",
        message: `File "${resolved}" has not been read first. Use file_read before applying ast-grep replacements. [TOOL_FILE_NOT_READ_FIRST]`,
      });
    }

    let currentMtime: number;
    try {
      currentMtime = statSync(resolved).mtimeMs;
    } catch {
      return createToolErrorResult({
        kind: "file-not-found",
        code: "TOOL_FILE_NOT_FOUND",
        message: `File "${resolved}" no longer exists. [TOOL_FILE_NOT_FOUND]`,
      });
    }

    const recordedMtime = snapshots.get(resolved)!;
    if (currentMtime !== recordedMtime) {
      return createToolErrorResult({
        kind: "write-conflict",
        code: "TOOL_FILE_WRITE_CONFLICT",
        message: `File "${resolved}" has been modified since it was read. Use file_read to refresh before applying ast-grep replacements. [TOOL_FILE_WRITE_CONFLICT]`,
      });
    }
  }

  return undefined;
}

type CapturedApplyFile = {
  path: string;
  resolved: string;
  before: string;
};

async function captureApplyFileContents(
  matches: AstGrepReplacementMatch[],
  ctx: ToolExecutionContext,
): Promise<CapturedApplyFile[]> {
  const files = getUniqueApplyFiles(matches, ctx);
  const captured: CapturedApplyFile[] = [];

  for (const file of files) {
    captured.push({ ...file, before: await Bun.file(file.resolved).text() });
  }

  return captured;
}

async function computeApplyDiffs(files: CapturedApplyFile[]) {
  try {
    const diffInputs = [];
    for (const file of files) {
      const after = await Bun.file(file.resolved).text();
      if (file.before === after) continue;
      diffInputs.push({ path: file.path, before: file.before, after, status: "modified" as const });
    }

    if (diffInputs.length === 0) {
      return files.length > 0 ? { version: 1 as const, files: [], unsupportedReason: "no_change" as const } : undefined;
    }

    return computeToolDiffs(diffInputs);
  } catch (error) {
    return {
      version: 1 as const,
      files: [],
      unsupportedReason: "diff_error" as const,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

function getUniqueApplyFiles(
  matches: AstGrepReplacementMatch[],
  ctx: ToolExecutionContext,
): Array<{ path: string; resolved: string }> {
  const files = new Map<string, { path: string; resolved: string }>();

  for (const match of matches) {
    const { resolved } = resolveAndValidatePath(match.file, ctx.workspaceRoot);
    files.set(resolved, { path: match.file, resolved });
  }

  return [...files.values()];
}

async function withApplyTargetQueues<T>(
  matches: AstGrepReplacementMatch[],
  ctx: ToolExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  const files = getUniqueApplyFiles(matches, ctx)
    .map((file) => file.resolved)
    .sort();

  let run = fn;
  for (let index = files.length - 1; index >= 0; index--) {
    const file = files[index];
    const next = run;
    run = () => sharedMutationQueue.enqueue(file, next);
  }

  return await run();
}

export function buildAstGrepReplaceArgs(input: AstGrepReplaceInput): string[] {
  const args = ["run", "--pattern", input.pattern, "--rewrite", input.rewrite];

  if (input.dryRun === false) args.push("--update-all");
  args.push("--json");

  if (input.lang) args.push("--lang", input.lang);
  for (const glob of input.globs ?? []) {
    args.push("--globs", glob);
  }
  args.push(...(input.paths ?? []));

  return args;
}

function parseAstGrepReplacementMatches(stdout: string): AstGrepReplacementMatch[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new AstGrepReplaceToolError("Failed to parse ast-grep JSON output", { cause: error });
  }

  const validation = AstGrepReplacementMatchesSchema.safeParse(parsed);
  if (!validation.success) {
    throw new AstGrepReplaceToolError("ast-grep returned invalid JSON replacement output", { cause: validation.error });
  }

  return validation.data;
}

function normalizeAstGrepReplaceResult(matches: AstGrepReplacementMatch[], dryRun: boolean) {
  return {
    dryRun,
    applied: !dryRun,
    count: matches.length,
    matches: matches.map((match) => ({
      file: match.file,
      text: match.text,
      lines: match.lines,
      replacement: match.replacement,
      ...(match.replacementOffsets ? { replacementOffsets: match.replacementOffsets } : {}),
      range: {
        byteOffset: match.range.byteOffset,
        start: match.range.start,
        end: match.range.end,
      },
      ...(match.metaVariables ? { metaVariables: match.metaVariables } : {}),
    })),
  };
}

function getAstGrepReplaceStdout(
  result: ProcessRunnerResult,
): { ok: true; stdout: string } | { ok: false; error: ToolExecutionResult } {
  switch (result.kind) {
    case "success":
      return { ok: true, stdout: result.output.stdout };
    case "nonzero":
      if (result.exitCode === 1 && !result.output.stdout.trim() && !result.output.stderr.trim()) return { ok: true, stdout: result.output.stdout };
      return {
        ok: false,
        error: createAstGrepReplaceErrorResult({
          error: new AstGrepReplaceToolError(formatAstGrepReplaceExitMessage(result.exitCode, result.output.stderr), { exitCode: result.exitCode }),
          message: formatAstGrepReplaceExitMessage(result.exitCode, result.output.stderr),
          meta: { exitCode: result.exitCode },
        }),
      };
    case "timeout":
      return {
        ok: false,
        error: createAstGrepReplaceErrorResult({
          message: `ast-grep timed out after ${result.timeoutMs}ms`,
          meta: { timeoutMs: result.timeoutMs },
        }),
      };
    case "aborted":
      return {
        ok: false,
        error: createAstGrepReplaceErrorResult({
          message: "ast-grep was aborted",
          meta: { astGrepAborted: true, reason: result.reason },
        }),
      };
    case "signal":
      return {
        ok: false,
        error: createAstGrepReplaceErrorResult({
          message: `ast-grep was terminated by signal ${result.signal}`,
          meta: { signal: result.signal, exitCode: result.exitCode },
        }),
      };
    case "spawn-failure":
      return {
        ok: false,
        error: createAstGrepReplaceErrorResult({
          error: new Error(result.error.message),
          message: result.error.message,
          meta: { argv: result.argv, cwd: result.cwd },
        }),
      };
  }
}

function createAstGrepReplaceWorkspacePermission(): ToolPermission {
  return (input: unknown, ctx: ToolExecutionContext): PermissionDecision => {
    const paths = (input as { paths?: unknown }).paths;
    if (!Array.isArray(paths)) return { outcome: "allow" };

    for (const path of paths) {
      if (typeof path !== "string") continue;
      const { resolved, isWithinWorkspace } = resolveAndValidatePath(path, ctx.workspaceRoot);
      if (!isWithinWorkspace) {
        return {
          outcome: "ask",
          reason: `"${resolved}" is outside workspace "${ctx.workspaceRoot}" [TOOL_FILE_OUTSIDE_WORKSPACE]`,
          approval: {
            eligible: true,
            scope: {
              kind: "file-path",
              operation: inputIsDryRun(input) ? "read" : "write",
              path: resolved,
              pathMode: "exact",
            },
            display: inputIsDryRun(input) ? `Access ${resolved}` : `Modify ${resolved}`,
            reason: "Path is outside workspace",
          },
          source: "tool-guard",
          ruleId: "tool-file-outside-workspace",
        };
      }
    }

    return { outcome: "allow" };
  };
}

function inputIsDryRun(input: unknown): boolean {
  return (input as { dryRun?: unknown }).dryRun !== false;
}

function formatAstGrepReplaceExitMessage(exitCode: number, stderr: string): string {
  return stderr ? `ast-grep exited with code ${exitCode}: ${stderr}` : `ast-grep exited with code ${exitCode}`;
}

function createAstGrepReplaceErrorResult(options: {
  error?: Error;
  message: string;
  meta?: Record<string, unknown>;
}): ToolExecutionResult {
  return createToolErrorResult({
    kind: "ast-grep-error",
    code: "TOOL_AST_GREP_ERROR",
    error: options.error,
    message: options.message,
    meta: options.meta,
  });
}

function toBinaryToolError(error: unknown): ToolExecutionResult | undefined {
  if (!error || typeof error !== "object" || !("toToolError" in error) || typeof error.toToolError !== "function") {
    return undefined;
  }

  return createToolErrorResult(error.toToolError());
}
