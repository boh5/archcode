import { z } from "zod";
import { createProcessRunner } from "../../process/runner";
import type { ProcessOutputSink, ProcessRunnerResult } from "../../process/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { RawToolResult } from "../types";

const GitDiffInputSchema = z.object({
  staged: z.boolean().optional().default(false).describe("false shows unstaged working-directory changes and is the default; true shows staged/cached changes. Call both views before a commit or final Git review."),
}).strict();

export function buildArgs(staged: boolean): string[] {
  const args: string[] = ["diff"];
  if (staged) args.push("--staged");
  args.push("--no-color", "--unified=3", "--no-ext-diff", "--no-renames");
  return args;
}

export function createGitDiffCaptureSink(
  capture: NonNullable<import("../types").ToolExecutionContext["outputCapture"]>,
): ProcessOutputSink {
  return { write: async (stream, chunk) => { if (stream === "stdout") await capture.write(chunk); } };
}

function processDetails(result: ProcessRunnerResult) {
  if (result.kind === "spawn-failure") return undefined;
  return {
    exitCode: result.kind === "signal" ? result.exitCode : result.kind === "timeout" || result.kind === "aborted" ? result.exitCode ?? null : result.exitCode,
    signal: result.kind === "signal" ? String(result.signal) : null,
    timedOut: result.kind === "timeout",
    aborted: result.kind === "aborted",
    durationMs: result.durationMs,
  };
}

function errorFromGitDiff(result: ProcessRunnerResult): RawToolResult | undefined {
  switch (result.kind) {
    case "success": return undefined;
    case "nonzero": return createToolErrorResult({ kind: "execution", message: `Git diff failed:\n${result.output.stderr}` });
    case "timeout": return createToolErrorResult({ kind: "execution", code: "TOOL_PROCESS_TIMEOUT", message: `Git diff timed out after ${result.timeoutMs}ms` });
    case "aborted": return createToolErrorResult({ kind: "execution", code: "TOOL_PROCESS_ABORTED", message: "Git diff was aborted" });
    case "signal": return createToolErrorResult({ kind: "execution", message: `Git diff was terminated by signal ${result.signal}` });
    case "spawn-failure": return createToolErrorResult({ kind: "execution", error: new Error(result.error.message), name: result.error.name });
  }
}

export const gitDiffTool = defineTool({
  name: "git_diff",
  description: [
    "Review tracked-file changes as a no-color unified diff with three context lines and no rename detection. staged=false shows unstaged working-directory changes; staged=true shows the staging area. Call both views before a commit or final Git review.",
    "",
    "git_diff does not show the contents of untracked files. Start with git_status to find them and use file_read when they are in scope. Use file_read for more surrounding context when a three-line diff hunk is insufficient.",
  ].join("\n"),
  inputSchema: GitDiffInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  execute: async (input, ctx): Promise<RawToolResult> => {
    if (!ctx.outputCapture) return createToolErrorResult({ kind: "execution", code: "TOOL_OUTPUT_UNAVAILABLE", message: "Git diff requires the registry output capture" });
    try {
      const result = await createProcessRunner().run({
        argv: ["git", ...buildArgs(input.staged)], cwd: ctx.cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, signal: ctx.abort,
        outputSink: createGitDiffCaptureSink(ctx.outputCapture),
      });
      const error = errorFromGitDiff(result);
      if (error) return { ...error, ...(processDetails(result) === undefined ? {} : { details: { ...error.details, process: processDetails(result)! } }) };
      return { isError: false, draft: { kind: "capture" }, details: { process: processDetails(result)! } };
    } catch (error) {
      return createToolErrorResult({ kind: "execution", error });
    }
  },
});
