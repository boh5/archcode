import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionResult } from "../types";
import { createProcessRunner } from "../../process/runner";
import type { ProcessRunnerResult } from "../../process/types";

// ─── Input Schema ───

const GitDiffInputSchema = z
  .object({
    staged: z.boolean().optional().default(false).describe("true = show staged (cached) changes, false = show unstaged working-directory changes. Default false."),
  })
  .strict();

// ─── Args Builder (exported for testing) ───

export function buildArgs(staged: boolean): string[] {
  const args: string[] = ["diff"];
  if (staged) {
    args.push("--staged");
  }
  args.push("--no-color", "--unified=3", "--no-ext-diff", "--no-renames");
  return args;
}

function formatGitDiffResult(result: ProcessRunnerResult): string | ToolExecutionResult {
  switch (result.kind) {
    case "success":
      if (!result.output.stdout.trim()) {
        return "No changes detected";
      }
      return result.output.stdout;
    case "nonzero":
      return createToolErrorResult({
        kind: "execution",
        message: `Git diff failed:\n${result.output.stderr}`,
      });
    case "timeout":
      return createToolErrorResult({
        kind: "execution",
        message: `Git diff timed out after ${result.timeoutMs}ms`,
      });
    case "aborted":
      return createToolErrorResult({
        kind: "execution",
        message: "Git diff was aborted",
      });
    case "signal":
      return createToolErrorResult({
        kind: "execution",
        message: `Git diff was terminated by signal ${result.signal}`,
      });
    case "spawn-failure":
      return createToolErrorResult({
        kind: "execution",
        message: result.error.message,
        name: result.error.name,
        details: result.error,
      });
  }
}

// ─── Tool Definition ───

export const gitDiffTool = defineTool({
  name: "git_diff",
  description:
    "Shows changes in the working directory (unstaged) or staging area (staged). Returns unified diff output.",
  inputSchema: GitDiffInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  execute: async (input, ctx): Promise<string | ToolExecutionResult> => {
    const args = buildArgs(input.staged);

    try {
      const result = await createProcessRunner().run({
        argv: ["git", ...args],
        cwd: ctx.cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        signal: ctx.abort,
      });
      return formatGitDiffResult(result);
    } catch (error) {
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
