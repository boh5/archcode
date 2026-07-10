import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionResult } from "../types";
import { createProcessRunner } from "../../process/runner";
import type { ProcessRunnerResult } from "../../process/types";

const GitStatusInputSchema = z.object({}).strict();

export function parseGitStatusOutput(raw: string): string {
  return raw
    .split("\0")
    .filter(Boolean)
    .join("\n");
}

interface GitStatusResult {
  output: string;
  exitCode: number;
}

const GIT_STATUS_ARGV = [
  "git",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--no-renames",
] as const;

export async function runGitStatus(
  cwd: string,
  signal: AbortSignal,
): Promise<GitStatusResult> {
  const result = await createProcessRunner().run({
    argv: GIT_STATUS_ARGV,
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    signal,
  });

  return formatGitStatusResult(result);
}

function formatGitStatusResult(result: ProcessRunnerResult): GitStatusResult {
  switch (result.kind) {
    case "success":
      return { output: parseGitStatusOutput(result.output.stdout), exitCode: result.exitCode };
    case "nonzero":
      return {
        output: result.output.stderr.trim() || `git status exited with code ${result.exitCode}`,
        exitCode: result.exitCode,
      };
    case "timeout":
      return {
        output: `git status timed out after ${result.timeoutMs}ms`,
        exitCode: 1,
      };
    case "aborted":
      return {
        output: "git status was aborted",
        exitCode: 1,
      };
    case "signal":
      return {
        output: `git status was terminated by signal ${result.signal}`,
        exitCode: 1,
      };
    case "spawn-failure":
      return {
        output: result.error.message,
        exitCode: 1,
      };
  }
}

export const gitStatusTool = defineTool({
  name: "git_status",
  description:
    "Shows the working tree status. Returns a list of changed files with status indicators (M=modified, A=added, D=deleted, ??=untracked).",
  inputSchema: GitStatusInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  execute: async (_input, ctx): Promise<string | ToolExecutionResult> => {
    try {
      const result = await runGitStatus(ctx.cwd, ctx.abort);
      if (result.exitCode !== 0) {
        return createToolErrorResult({
          kind: "execution",
          message: result.output || `git status exited with code ${result.exitCode}`,
        });
      }
      return result.output;
    } catch (e) {
      return createToolErrorResult({
        kind: "execution",
        error: e instanceof Error ? e : new Error(String(e)),
        message: `Failed to run git status: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
});
