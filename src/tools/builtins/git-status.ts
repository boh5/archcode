import { z } from "zod";
import { defineTool } from "../define-tool";

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

export async function runGitStatus(
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<GitStatusResult> {
  const proc = Bun.spawn(
    [
      "git",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      cwd: workspaceRoot,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      signal,
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout!).text(),
    new Response(proc.stderr!).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return {
      output: stderr.trim() || `git status exited with code ${exitCode}`,
      exitCode,
    };
  }

  return { output: parseGitStatusOutput(stdout), exitCode };
}

export const gitStatusTool = defineTool({
  name: "git_status",
  description:
    "Shows the working tree status. Returns a list of changed files with status indicators (M=modified, A=added, D=deleted, ??=untracked).",
  inputSchema: GitStatusInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  execute: async (_input, ctx) => {
    try {
      const result = await runGitStatus(ctx.workspaceRoot, ctx.abort);
      if (result.exitCode !== 0) {
        throw new Error(result.output);
      }
      return result.output;
    } catch (e) {
      throw new Error(
        `Failed to run git status: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
});
