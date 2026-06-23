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
    pattern: z.string().describe("Regular expression pattern to search for in file contents"),
    path: z.string().optional().describe("Directory to search in (absolute or workspace-relative). Defaults to workspace root."),
    include: z.string().optional().describe("File name glob to filter by (e.g. \"*.ts\"). Defaults to all files."),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("Output format: \"content\" shows matching lines, \"files_with_matches\" lists file paths only, \"count\" shows match counts per file. Default \"content\"."),
    context: z.number().optional().describe("Number of context lines to show around each match"),
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
  description: "Search file contents using ripgrep",
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
          cwd: ctx.workspaceRoot,
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
