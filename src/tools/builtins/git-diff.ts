import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionResult } from "../types";

// ─── Input Schema ───

const GitDiffInputSchema = z
  .object({
    staged: z.boolean().optional().default(false),
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
      const proc = Bun.spawn(["git", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: ctx.workspaceRoot,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        signal: ctx.abort,
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        return createToolErrorResult({
          kind: "execution",
          message: `Git diff failed:\n${stderr}`,
        });
      }

      if (!stdout.trim()) {
        return "No changes detected";
      }

      return stdout;
    } catch (error) {
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
