import { z } from "zod";

import { createBinaryManager } from "../../../binary/manager";
import { createProcessRunner } from "../../../process/runner";
import type { ProcessRunnerResult } from "../../../process/types";
import { defineTool } from "../../define-tool";
import { createToolErrorResult } from "../../errors";
import { createTextToolResult } from "../../results";
import type { RawToolResult, ToolExecutionContext, ToolPermission, PermissionDecision } from "../../types";
import { resolveAndValidatePath } from "../../security";
import { AstGrepNdjsonCollector } from "./ndjson";

export const AstGrepSearchInputSchema = z
  .object({
    pattern: z.string().min(1).describe("Parseable ast-grep code pattern, not a regular expression. `$VAR` matches one AST node and `$$$` matches zero or more nodes; provide a complete code node rather than a fragment."),
    lang: z.string().min(1).optional().describe("Target language used to parse the pattern and files. One of: bash, c, cpp, csharp, css, elixir, go, haskell, html, java, javascript, json, kotlin, lua, nix, php, python, ruby, rust, scala, solidity, swift, typescript, tsx, yaml. Omit only when file extensions can determine it reliably."),
    paths: z.array(z.string().min(1)).optional().describe("Files or directories to search, absolute or relative to the current Session cwd. Defaults to the Session cwd."),
    globs: z.array(z.string().min(1)).optional().describe("File include/exclude globs; prefix an exclusion with `!`, for example [`*.ts`, `!*.test.ts`]."),
  })
  .strict();

type AstGrepSearchInput = z.infer<typeof AstGrepSearchInputSchema>;

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
  description: "Search parsed code by AST structure, not text regex. Use grep for comments, string contents, file names, or byte-oriented regex. The pattern must be a parseable code node: `$VAR` captures one AST node and `$$$` captures zero or more nodes. Returns canonical NDJSON from ast-grep --json=stream.",
  inputSchema: AstGrepSearchInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  permissions: [createAstGrepWorkspacePermission()],
  async execute(input, ctx): Promise<RawToolResult> {
    try {
      const astGrepPath = await createBinaryManager().resolve("ast-grep");
      const collector = new AstGrepNdjsonCollector(
        () => undefined,
      );
      const result = await createProcessRunner().run({
        argv: [astGrepPath, ...buildAstGrepSearchArgs(input)],
        cwd: ctx.cwd,
        env: { ...process.env },
        signal: ctx.abort,
        outputSink: createAstGrepSink(collector, ctx.outputCapture),
      });

      const output = getAstGrepStdout(result);
      if (output.ok === false) return output.error;

      collector.finish();
      return ctx.outputCapture === undefined
        ? createTextToolResult(output.stdout)
        : { isError: false, draft: { kind: "capture" } };
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
  const args = ["run", "--pattern", input.pattern, "--json=stream"];

  if (input.lang) args.push("--lang", input.lang);
  for (const glob of input.globs ?? []) {
    args.push("--globs", glob);
  }
  args.push(...(input.paths ?? []));

  return args;
}

function getAstGrepStdout(
  result: ProcessRunnerResult,
): { ok: true; stdout: string } | { ok: false; error: RawToolResult } {
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
        }),
      };
    case "timeout":
      return {
        ok: false,
        error: createAstGrepErrorResult({
          message: `ast-grep timed out after ${result.timeoutMs}ms`,
        }),
      };
    case "aborted":
      return {
        ok: false,
        error: createAstGrepErrorResult({
          message: "ast-grep was aborted",
        }),
      };
    case "signal":
      return {
        ok: false,
        error: createAstGrepErrorResult({
          message: `ast-grep was terminated by signal ${result.signal}`,
        }),
      };
    case "spawn-failure":
      return {
        ok: false,
        error: createAstGrepErrorResult({
          error: new Error(result.error.message),
          message: result.error.message,
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

function createAstGrepSink(
  collector: AstGrepNdjsonCollector,
  capture: ToolExecutionContext["outputCapture"],
) {
  return {
    async write(stream: "stdout" | "stderr", chunk: Uint8Array): Promise<void> {
      collector.write(stream, chunk);
      if (stream === "stdout" && capture !== undefined) await capture.write(chunk);
    },
  };
}
