import { statSync } from "node:fs";
import { z } from "zod";

import { createBinaryManager } from "../../../binary/manager";
import { createProcessRunner } from "../../../process/runner";
import type { ProcessRunnerResult } from "../../../process/types";
import { sharedMutationQueue } from "../../concurrency/mutation-queue";
import { defineTool } from "../../define-tool";
import { computeToolDiffs } from "../../diff";
import { createToolErrorResult } from "../../errors";
import { createTextToolResult } from "../../results";
import { createPostEditDiagnosticsHook } from "../../hooks";
import { createProtectedPathPermission, isProtectedToolWritePath } from "../../permission";
import { resolveAndValidatePath } from "../../security";
import type { PermissionDecision, RawToolResult, ToolExecutionContext, ToolPermission } from "../../types";
import { AstGrepNdjsonCollector } from "./ndjson";

export const AstGrepReplaceInputSchema = z
  .object({
    pattern: z.string().min(1).describe("Parseable ast-grep code pattern to match. `$VAR` captures one AST node and `$$$` captures zero or more nodes."),
    rewrite: z.string().min(1).describe("Replacement code pattern. Reuse captured `$VAR` or `$$$` values to preserve matched content."),
    lang: z.string().min(1).optional().describe("Target language for parsing the pattern, rewrite, and files. See ast_grep_search lang for supported values."),
    paths: z.array(z.string().min(1)).optional().describe("Files or directories to preview or rewrite, absolute or relative to the current Session cwd. Keep identical between preview and apply."),
    globs: z.array(z.string().min(1)).optional().describe("Include/exclude file globs. Prefix exclusions with `!`; keep identical between preview and apply."),
    dryRun: z.boolean().default(true).describe("`true` previews matches without writing and is the default. After reviewing that preview, repeat the same call with `false` to apply."),
  })
  .strict();

const AST_GREP_MAX_MATCHES = 10_000;
const AST_GREP_MAX_UNIQUE_FILES = 1_000;
const AST_GREP_MAX_PATH_BYTES = 4 * 1024 * 1024;

type AstGrepReplaceInput = z.infer<typeof AstGrepReplaceInputSchema>;
type AstGrepReplacementTarget = { file: string };

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
    "Preview or apply an AST-structural rewrite. First call with `dryRun: true` and inspect the returned matches. Apply only after the preview is correct by calling again with the same pattern, rewrite, language, paths, and globs and `dryRun: false`. Applying requires current read snapshots for every matched file and rechecks protected paths.",
  inputSchema: AstGrepReplaceInputSchema,
  traits: {
    readOnly: false,
    destructive: true,
    concurrencySafe: false,
  },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  permissions: [createAstGrepReplaceWorkspacePermission(), createProtectedPathPermission()],
  hooks: { after: [createPostEditDiagnosticsHook({ inputPathKeys: [] })] },
  async execute(input, ctx): Promise<RawToolResult> {
    try {
      const astGrepPath = await createBinaryManager().resolve("ast-grep");
      const runner = createProcessRunner();
      let matches: AstGrepReplacementTarget[];

      if (input.dryRun === false) {
        const previewInput = { ...input, dryRun: true };
        const previewResult = await runAstGrepReplace(astGrepPath, previewInput, ctx, runner, false, true);
        if ("isError" in previewResult) return previewResult;
        matches = previewResult.matches;

        const protectedPreviewCheck = checkApplyProtectedPath(matches, ctx);
        if (protectedPreviewCheck) return protectedPreviewCheck;

        const snapshotCheck = checkApplyReadSnapshots(matches, ctx);
        if (snapshotCheck) return snapshotCheck;

        if (matches.length === 0) {
          return ctx.outputCapture === undefined
            ? createTextToolResult("")
            : { isError: false, draft: { kind: "capture" } };
        }

        return await withApplyTargetQueues(matches, ctx, async () => {
          const lockedPreview = await runAstGrepReplace(astGrepPath, previewInput, ctx, runner, false, true);
          if ("isError" in lockedPreview) return lockedPreview;
          const lockedProtectedCheck = checkApplyProtectedPath(lockedPreview.matches, ctx);
          if (lockedProtectedCheck) return lockedProtectedCheck;
          if (!sameApplyTargets(matches, lockedPreview.matches, ctx)) {
            return createToolErrorResult({
              kind: "write-conflict",
              code: "TOOL_FILE_WRITE_CONFLICT",
              message: "ast-grep replacement targets changed while waiting for the mutation lock; preview again",
            });
          }
          matches = lockedPreview.matches;
          const lockedSnapshotCheck = checkApplyReadSnapshots(matches, ctx);
          if (lockedSnapshotCheck) return lockedSnapshotCheck;

          const beforeFiles = await captureApplyFileContents(matches, ctx);
          const applyResult = await runAstGrepReplace(
            astGrepPath,
            { ...input, paths: [...new Set(matches.map((match) => match.file))], globs: undefined },
            ctx,
            runner,
            true,
            false,
          );
          if ("isError" in applyResult) return applyResult;

          const output = applyResult.canonical;
          const diffs = await computeApplyDiffs(beforeFiles);
          if (ctx.outputCapture !== undefined) {
            return {
              isError: false,
              draft: { kind: "capture" },
              ...(diffs?.files === undefined ? {} : { details: { presentations: [{ kind: "diff", files: diffs.files }] } }),
            };
          }
          return createTextToolResult(output, {
            ...(diffs?.files === undefined ? {} : { details: { presentations: [{ kind: "diff", files: diffs.files }] } }),
          });
        });
      } else {
        const previewResult = await runAstGrepReplace(astGrepPath, input, ctx, runner, true, true);
        if ("isError" in previewResult) return previewResult;
        matches = previewResult.matches;
        return ctx.outputCapture === undefined
          ? createTextToolResult(previewResult.canonical)
          : { isError: false, draft: { kind: "capture" } };
      }

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
  captureCanonical: boolean,
  collectMatches: boolean,
): Promise<{ matches: AstGrepReplacementTarget[]; canonical: string } | RawToolResult> {
  const matches: AstGrepReplacementTarget[] = [];
  const files = new Set<string>();
  let pathBytes = 0;
  const collector = collectMatches ? new AstGrepNdjsonCollector(
    (record) => {
      if (matches.length >= AST_GREP_MAX_MATCHES) throw new AstGrepReplaceToolError(`ast-grep replacement exceeds ${AST_GREP_MAX_MATCHES} matches`);
      matches.push({ file: record.file });
      pathBytes += new TextEncoder().encode(record.file).byteLength;
      if (pathBytes > AST_GREP_MAX_PATH_BYTES) throw new AstGrepReplaceToolError(`ast-grep replacement paths exceed ${AST_GREP_MAX_PATH_BYTES} bytes`);
      files.add(record.file);
      if (files.size > AST_GREP_MAX_UNIQUE_FILES) throw new AstGrepReplaceToolError(`ast-grep replacement exceeds ${AST_GREP_MAX_UNIQUE_FILES} unique files`);
    },
  ) : undefined;
  const result = await runner.run({
    argv: [astGrepPath, ...buildAstGrepReplaceArgs(input)],
    cwd: ctx.cwd,
    env: { ...process.env },
    signal: ctx.abort,
    outputSink: createAstGrepReplaceSink(collector, captureCanonical ? ctx.outputCapture : undefined),
  });

  const output = getAstGrepReplaceStdout(result);
  if (output.ok === false) return output.error;

  try {
    collector?.finish();
    return { matches, canonical: output.stdout };
  } catch (error) {
    return createAstGrepReplaceErrorResult({
      error: error instanceof Error ? error : new Error(String(error)),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function sameApplyTargets(
  left: AstGrepReplacementTarget[],
  right: AstGrepReplacementTarget[],
  ctx: ToolExecutionContext,
): boolean {
  const normalize = (matches: AstGrepReplacementTarget[]) => [...new Set(
    matches.map((match) => resolveAndValidatePath(match.file, ctx.cwd).resolved),
  )].sort();
  const leftFiles = normalize(left);
  const rightFiles = normalize(right);
  return leftFiles.length === rightFiles.length && leftFiles.every((file, index) => file === rightFiles[index]);
}

function checkApplyProtectedPath(
  matches: AstGrepReplacementTarget[],
  ctx: ToolExecutionContext,
): RawToolResult | undefined {
  const protectedMatch = matches.find((match) => isProtectedToolWritePath(match.file, ctx));
  if (!protectedMatch) return undefined;

  return createToolErrorResult({
    kind: "permission-denied",
    code: "PROTECTED_PATH_WRITE_DENIED",
    message:
      `Cannot apply ast-grep replacement to system-managed .archcode path "${protectedMatch.file}". ` +
      "Use the appropriate goal or memory tool instead.",
  });
}

function checkApplyReadSnapshots(
  matches: AstGrepReplacementTarget[],
  ctx: ToolExecutionContext,
): RawToolResult | undefined {
  const snapshots = ctx.store.getState().readSnapshots;
  const files = new Set(matches.map((match) => match.file));

  for (const file of files) {
    const { resolved } = resolveAndValidatePath(file, ctx.cwd);
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
  matches: AstGrepReplacementTarget[],
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
      return files.length > 0 ? { files: [], unsupportedReason: "no_change" as const } : undefined;
    }

    return computeToolDiffs(diffInputs);
  } catch (error) {
    return {
      files: [],
      unsupportedReason: "diff_error" as const,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

function getUniqueApplyFiles(
  matches: AstGrepReplacementTarget[],
  ctx: ToolExecutionContext,
): Array<{ path: string; resolved: string }> {
  const files = new Map<string, { path: string; resolved: string }>();

  for (const match of matches) {
    const { resolved } = resolveAndValidatePath(match.file, ctx.cwd);
    files.set(resolved, { path: match.file, resolved });
  }

  return [...files.values()];
}

async function withApplyTargetQueues<T>(
  matches: AstGrepReplacementTarget[],
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
  args.push("--json=stream");

  if (input.lang) args.push("--lang", input.lang);
  for (const glob of input.globs ?? []) {
    args.push("--globs", glob);
  }
  args.push(...(input.paths ?? []));

  return args;
}

function getAstGrepReplaceStdout(
  result: ProcessRunnerResult,
): { ok: true; stdout: string } | { ok: false; error: RawToolResult } {
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
        }),
      };
    case "timeout":
      return {
        ok: false,
        error: createAstGrepReplaceErrorResult({
          message: `ast-grep timed out after ${result.timeoutMs}ms`,
        }),
      };
    case "aborted":
      return {
        ok: false,
        error: createAstGrepReplaceErrorResult({
          message: "ast-grep was aborted",
        }),
      };
    case "signal":
      return {
        ok: false,
        error: createAstGrepReplaceErrorResult({
          message: `ast-grep was terminated by signal ${result.signal}`,
        }),
      };
    case "spawn-failure":
      return {
        ok: false,
        error: createAstGrepReplaceErrorResult({
          error: new Error(result.error.message),
          message: result.error.message,
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
      const { resolved, isWithinWorkspace } = resolveAndValidatePath(path, ctx.cwd);
      if (!isWithinWorkspace) {
        return {
          outcome: "ask",
          reason: `"${resolved}" is outside workspace "${ctx.cwd}" [TOOL_FILE_OUTSIDE_WORKSPACE]`,
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
}): RawToolResult {
  return createToolErrorResult({
    kind: "ast-grep-error",
    code: "TOOL_AST_GREP_ERROR",
    error: options.error,
    message: options.message,
  });
}

function toBinaryToolError(error: unknown): RawToolResult | undefined {
  if (!error || typeof error !== "object" || !("toToolError" in error) || typeof error.toToolError !== "function") {
    return undefined;
  }

  return createToolErrorResult(error.toToolError());
}

function createAstGrepReplaceSink(
  collector: AstGrepNdjsonCollector | undefined,
  capture: ToolExecutionContext["outputCapture"],
) {
  return {
    async write(stream: "stdout" | "stderr", chunk: Uint8Array): Promise<void> {
      collector?.write(stream, chunk);
      if (stream === "stdout" && capture !== undefined) await capture.write(chunk);
    },
  };
}
