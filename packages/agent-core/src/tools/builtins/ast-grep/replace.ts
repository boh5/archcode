import { statSync } from "node:fs";
import { z } from "zod";

import { createBinaryManager } from "../../../binary/manager";
import { createProcessRunner } from "../../../process/runner";
import type { ProcessRunnerResult } from "../../../process/types";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import { resolveAndValidatePath } from "../../security";
import type { PermissionDecision, ToolExecutionContext, ToolExecutionResult, ToolPermission } from "../../types";

export const AstGrepReplaceInputSchema = z
  .object({
    pattern: z.string().min(1),
    rewrite: z.string().min(1),
    lang: z.string().min(1).optional(),
    paths: z.array(z.string().min(1)).optional(),
    globs: z.array(z.string().min(1)).optional(),
    dryRun: z.boolean().default(true),
  })
  .strict();

const AstGrepRangePositionSchema = z
  .object({
    line: z.number(),
    column: z.number(),
  })
  .strict();

const AstGrepReplacementMatchSchema = z
  .object({
    text: z.string(),
    range: z
      .object({
        byteOffset: z
          .object({
            start: z.number(),
            end: z.number(),
          })
          .strict(),
        start: AstGrepRangePositionSchema,
        end: AstGrepRangePositionSchema,
      })
      .strict(),
    file: z.string(),
    lines: z.string(),
    replacement: z.string().optional(),
    replacementOffsets: z
      .object({
        start: z.number(),
        end: z.number(),
      })
      .strict()
      .optional(),
    metaVariables: z
      .object({
        single: z.record(z.string(), z.object({ name: z.string(), text: z.string() }).strict()).optional(),
        multi: z.record(z.string(), z.array(z.object({ name: z.string(), text: z.string() }).strict())).optional(),
        transformed: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

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
  permissions: [createAstGrepReplaceWorkspacePermission()],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    try {
      const astGrepPath = await createBinaryManager().resolve("ast-grep");
      const runner = createProcessRunner();
      let matches: AstGrepReplacementMatch[];

      if (input.dryRun === false) {
        const previewResult = await runAstGrepReplace(astGrepPath, { ...input, dryRun: true }, ctx, runner);
        if ("isError" in previewResult) return previewResult;
        matches = previewResult;

        const snapshotCheck = checkApplyReadSnapshots(matches, ctx);
        if (snapshotCheck) return snapshotCheck;

        const applyResult = await runAstGrepReplace(astGrepPath, input, ctx, runner);
        if ("isError" in applyResult) return applyResult;
        matches = applyResult;
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
      if (result.exitCode === 1) return { ok: true, stdout: result.output.stdout };
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
