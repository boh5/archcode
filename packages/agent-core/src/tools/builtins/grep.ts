import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createRipgrepService } from "../ripgrep/service";
import type { RipgrepService } from "../ripgrep/service";
import { createWorkspacePermission } from "../permission";
import { createProcessRunner } from "../../process/runner";
import type { ProcessRunnerResult } from "../../process/types";
import { buildFileListArgs, buildCountArgs, buildSearchArgs, formatSearchResult, parseRgOutput } from "../ripgrep/search";
import type { ToolExecutionResult } from "../types";

// ─── Schema ───

export const GrepInputSchema = z
  .object({
    pattern: z.string().describe("Ripgrep regular expression to search for in file contents, for example `defineTool\\(` or `class\\s+ToolRegistry`."),
    path: z.string().optional().describe("File or directory to search, absolute or relative to the current Session cwd. Defaults to the Session cwd."),
    include: z.string().optional().describe("File-name glob used to filter searched files, for example `*.ts` or `*.{ts,tsx}`."),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("`content` returns matching lines, `files_with_matches` returns paths only, and `count` returns per-file counts. Default `content`. At most 100 entries are returned."),
    context: z.number().optional().describe("Number of lines before and after each match. Used only with output_mode `content`."),
  })
  .strict();

// ─── Service injection ───

let rgService: RipgrepService = createRipgrepService();

export function setRipgrepService(service: RipgrepService): void {
  rgService = service;
}

// ─── Tool descriptor ───

export const grepTool = defineTool({
  name: "grep",
  description: [
    "Search file contents with ripgrep regular expressions. Prefer this tool to `rg` or `grep` through bash. Use glob when searching for file names rather than contents.",
    "",
    "Typical workflow: locate candidate content with `grep({\"pattern\":\"defineTool\\\\(\",\"path\":\"packages/agent-core/src\",\"include\":\"*.ts\",\"output_mode\":\"content\",\"context\":2})`, then use file_read on the returned paths and line ranges. Use `files_with_matches` to obtain only paths and `count` for per-file counts. Results are limited to the first 100 entries, so narrow path/include/pattern and retry when the result is truncated.",
    "",
    "If the investigation is open-ended across unknown modules and will require repeated rounds of searching, delegate one concrete research question to Explore when delegate is available instead of manually reproducing the same exploration loop.",
  ].join("\n"),
  inputSchema: GrepInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  permissions: [createWorkspacePermission()],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    try {
      const rgPath = await rgService.ensure();
      const outputMode = input.output_mode ?? "content";
      const runner = createProcessRunner();

      const runRg = async (args: string[]) => {
        return runner.run({
          argv: [rgPath, ...args],
          cwd: ctx.cwd,
          env: { ...process.env },
          signal: ctx.abort,
        });
      };

      if (outputMode === "files_with_matches") {
        return await formatFileListResult(await runRg(buildFileListArgs(input.pattern, input.include, input.path)), input.pattern);
      }

      if (outputMode === "count") {
        return await formatFileListResult(await runRg(buildCountArgs(input.pattern, input.include, input.path)), input.pattern);
      }

      const searchArgs = {
        pattern: input.pattern,
        path: input.path,
        include: input.include,
        context: input.context,
      };

      const result = await runRg(buildSearchArgs(searchArgs));
      const output = getProcessRunnerStdout(result);
      if (output.ok === false) return output.error;

      const parsed = parseRgOutput(output.stdout, 100);

      if (parsed.matches.length === 0) {
        return `No matches found for pattern: ${input.pattern}`;
      }

      const formatted = formatSearchResult(parsed, "content");

      if (parsed.truncated) {
        return `${formatted}\n[Output truncated: showing first 100 matches]`;
      }

      return formatted;
    } catch (error) {
      return createToolErrorResult({
        kind: "grep-error",
        code: "TOOL_GREP_ERROR",
        error: error instanceof Error ? error : new Error(String(error)),
        message: `grep failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },
});

async function formatFileListResult(result: ProcessRunnerResult, pattern: string): Promise<string | ToolExecutionResult> {
  const output = getProcessRunnerStdout(result);
  if (output.ok === false) return output.error;

  const stdout = output.stdout;
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return `No matches found for pattern: ${pattern}`;
  }

  const truncated = lines.length > 100;
  const display = truncated ? lines.slice(0, 100) : lines;
  let formatted = display.join("\n");
  if (truncated) {
    formatted += "\n[Output truncated: showing first 100 files]";
  }
  return formatted;
}

function getProcessRunnerStdout(
  result: ProcessRunnerResult,
): { ok: true; stdout: string } | { ok: false; error: ToolExecutionResult } {
  switch (result.kind) {
    case "success":
      return { ok: true, stdout: result.output.stdout };
    case "nonzero":
      if (result.exitCode === 1 && !result.output.stdout.trim() && !result.output.stderr.trim()) return { ok: true, stdout: result.output.stdout };
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          message: result.output.stderr
            ? `rg exited with code ${result.exitCode}: ${result.output.stderr}`
            : `rg exited with code ${result.exitCode}`,
          meta: { exitCode: result.exitCode },
        }),
      };
    case "timeout":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          message: `rg timed out after ${result.timeoutMs}ms`,
          meta: { timeoutMs: result.timeoutMs },
        }),
      };
    case "aborted":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          message: "rg was aborted",
          meta: { aborted: true },
        }),
      };
    case "signal":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          message: `rg was terminated by signal ${result.signal}`,
          meta: { signal: result.signal, exitCode: result.exitCode },
        }),
      };
    case "spawn-failure":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          error: new Error(result.error.message),
          message: result.error.message,
          meta: { argv: result.argv, cwd: result.cwd },
        }),
      };
  }
}
