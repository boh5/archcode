import { z } from "zod";

import { createBinaryManager } from "../../../binary/manager";
import { createProcessRunner } from "../../../process/runner";
import type { ProcessRunnerResult } from "../../../process/types";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import type { ToolExecutionContext, ToolExecutionResult, ToolPermission, PermissionDecision } from "../../types";
import { resolveAndValidatePath } from "../../security";

export const AstGrepSearchInputSchema = z
  .object({
    pattern: z.string().min(1).describe("Parseable ast-grep code pattern, not a regular expression. `$VAR` matches one AST node and `$$$` matches zero or more nodes; provide a complete code node rather than a fragment."),
    lang: z.string().min(1).optional().describe("Target language used to parse the pattern and files. One of: bash, c, cpp, csharp, css, elixir, go, haskell, html, java, javascript, json, kotlin, lua, nix, php, python, ruby, rust, scala, solidity, swift, typescript, tsx, yaml. Omit only when file extensions can determine it reliably."),
    paths: z.array(z.string().min(1)).optional().describe("Files or directories to search, absolute or relative to the current Session cwd. Defaults to the Session cwd."),
    globs: z.array(z.string().min(1)).optional().describe("File include/exclude globs; prefix an exclusion with `!`, for example [`*.ts`, `!*.test.ts`]."),
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

/**
 * Match node in metaVariables — ast-grep outputs { text, range } where
 * the key in the record IS the variable name (no "name" field).
 * Uses passthrough to accept future fields from newer ast-grep versions.
 */
const AstGrepMatchNodeSchema = z
  .object({
    text: z.string(),
    range: AstGrepRangeSchema.optional(),
  })
  .passthrough();

const AstGrepMatchSchema = z
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

const AstGrepMatchesSchema = z.array(AstGrepMatchSchema);

type AstGrepSearchInput = z.infer<typeof AstGrepSearchInputSchema>;
type AstGrepMatch = z.infer<typeof AstGrepMatchSchema>;

export class AstGrepToolError extends Error {
  readonly exitCode?: number;

  constructor(message: string, params: { exitCode?: number; cause?: unknown } = {}) {
    super(message, { cause: params.cause });
    this.name = "AstGrepToolError";
    this.exitCode = params.exitCode;
  }
}

export const astGrepSearchTool = defineTool({
  name: "ast_grep_search",
  description: "Search parsed code by AST structure, not text regex. Use grep for comments, string contents, file names, or byte-oriented regex. The pattern must be a parseable code node: `$VAR` captures one AST node and `$$$` captures zero or more nodes. Returns normalized JSON matches.",
  inputSchema: AstGrepSearchInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  permissions: [createAstGrepWorkspacePermission()],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    try {
      const astGrepPath = await createBinaryManager().resolve("ast-grep");
      const result = await createProcessRunner().run({
        argv: [astGrepPath, ...buildAstGrepSearchArgs(input)],
        cwd: ctx.cwd,
        env: { ...process.env },
        signal: ctx.abort,
      });

      const output = getAstGrepStdout(result);
      if (output.ok === false) return output.error;

      const matches = parseAstGrepMatches(output.stdout);
      return JSON.stringify(normalizeAstGrepSearchResult(matches), null, 2);
    } catch (error) {
      const maybeBinaryError = toBinaryToolError(error);
      if (maybeBinaryError) return maybeBinaryError;

      return createAstGrepErrorResult({
        error: error instanceof Error ? error : new Error(String(error)),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

export function buildAstGrepSearchArgs(input: AstGrepSearchInput): string[] {
  const args = ["run", "--pattern", input.pattern, "--json"];

  if (input.lang) args.push("--lang", input.lang);
  for (const glob of input.globs ?? []) {
    args.push("--globs", glob);
  }
  args.push(...(input.paths ?? []));

  return args;
}

function parseAstGrepMatches(stdout: string): AstGrepMatch[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new AstGrepToolError("Failed to parse ast-grep JSON output", { cause: error });
  }

  const validation = AstGrepMatchesSchema.safeParse(parsed);
  if (!validation.success) {
    throw new AstGrepToolError("ast-grep returned invalid JSON match output", { cause: validation.error });
  }

  return validation.data;
}

function normalizeAstGrepSearchResult(matches: AstGrepMatch[]) {
  return {
    count: matches.length,
    matches: matches.map((match) => ({
      file: match.file,
      text: match.text,
      lines: match.lines,
      range: {
        byteOffset: match.range.byteOffset,
        start: match.range.start,
        end: match.range.end,
      },
      ...(match.metaVariables ? { metaVariables: match.metaVariables } : {}),
    })),
  };
}

function getAstGrepStdout(
  result: ProcessRunnerResult,
): { ok: true; stdout: string } | { ok: false; error: ToolExecutionResult } {
  switch (result.kind) {
    case "success":
      return { ok: true, stdout: result.output.stdout };
    case "nonzero":
      if (result.exitCode === 1 && !result.output.stdout.trim() && !result.output.stderr.trim()) return { ok: true, stdout: result.output.stdout };
      return {
        ok: false,
        error: createAstGrepErrorResult({
          error: new AstGrepToolError(formatAstGrepExitMessage(result.exitCode, result.output.stderr), { exitCode: result.exitCode }),
          message: formatAstGrepExitMessage(result.exitCode, result.output.stderr),
          meta: { exitCode: result.exitCode },
        }),
      };
    case "timeout":
      return {
        ok: false,
        error: createAstGrepErrorResult({
          message: `ast-grep timed out after ${result.timeoutMs}ms`,
          meta: { timeoutMs: result.timeoutMs },
        }),
      };
    case "aborted":
      return {
        ok: false,
        error: createAstGrepErrorResult({
          message: "ast-grep was aborted",
          meta: { astGrepAborted: true, reason: result.reason },
        }),
      };
    case "signal":
      return {
        ok: false,
        error: createAstGrepErrorResult({
          message: `ast-grep was terminated by signal ${result.signal}`,
          meta: { signal: result.signal, exitCode: result.exitCode },
        }),
      };
    case "spawn-failure":
      return {
        ok: false,
        error: createAstGrepErrorResult({
          error: new Error(result.error.message),
          message: result.error.message,
          meta: { argv: result.argv, cwd: result.cwd },
        }),
      };
  }
}

function createAstGrepWorkspacePermission(): ToolPermission {
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
              operation: "read",
              path: resolved,
              pathMode: "exact",
            },
            display: `Access ${resolved}`,
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

function formatAstGrepExitMessage(exitCode: number, stderr: string): string {
  return stderr ? `ast-grep exited with code ${exitCode}: ${stderr}` : `ast-grep exited with code ${exitCode}`;
}

function createAstGrepErrorResult(options: {
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
