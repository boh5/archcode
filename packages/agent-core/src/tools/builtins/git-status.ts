import { z } from "zod";
import { createProcessRunner } from "../../process/runner";
import type { ProcessOutputSink, ProcessRunnerResult } from "../../process/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { RawToolResult } from "../types";

const GitStatusInputSchema = z.object({}).strict();

const GIT_STATUS_ARGV = [
  "git",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--no-renames",
] as const;

/** Convert porcelain NUL records as they arrive, without ever retaining stdout. */
export function createGitStatusCaptureSink(
  capture: NonNullable<import("../types").ToolExecutionContext["outputCapture"]>,
): ProcessOutputSink {
  return {
    async write(stream, chunk) {
      if (stream !== "stdout") return;
      const formatted = chunk.slice();
      for (let index = 0; index < formatted.byteLength; index++) {
        if (formatted[index] === 0) formatted[index] = 0x0a;
      }
      await capture.write(formatted);
    },
  };
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

function errorFromGitStatus(result: ProcessRunnerResult): RawToolResult | undefined {
  switch (result.kind) {
    case "success":
      return undefined;
    case "nonzero":
      return createToolErrorResult({ kind: "execution", message: result.output.stderr.trim() || `git status exited with code ${result.exitCode}` });
    case "timeout":
      return createToolErrorResult({ kind: "execution", code: "TOOL_PROCESS_TIMEOUT", message: `git status timed out after ${result.timeoutMs}ms` });
    case "aborted":
      return createToolErrorResult({ kind: "execution", code: "TOOL_PROCESS_ABORTED", message: "git status was aborted" });
    case "signal":
      return createToolErrorResult({ kind: "execution", message: `git status was terminated by signal ${result.signal}` });
    case "spawn-failure":
      return createToolErrorResult({ kind: "execution", error: new Error(result.error.message), name: result.error.name });
  }
}

export const gitStatusTool = defineTool({
  name: "git_status",
  description: [
    "Inventory the Git working tree before editing, staging, committing, or reviewing a change. It returns porcelain status with all untracked paths and no rename detection; common indicators include M=modified, A=added, D=deleted, and ??=untracked. Empty output means the working tree is clean.",
    "",
    "Typical review workflow: git_status -> git_diff with staged=false -> git_diff with staged=true. git_status reports untracked paths but not their contents, so use file_read for any untracked file that may be in scope. For commits, history rewrites, branch operations, or PR preparation, read the git-master Skill first when available.",
  ].join("\n"),
  inputSchema: GitStatusInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  execute: async (_input, ctx): Promise<RawToolResult> => {
    if (!ctx.outputCapture) {
      return createToolErrorResult({ kind: "execution", code: "TOOL_OUTPUT_UNAVAILABLE", message: "Git status requires the registry output capture" });
    }
    try {
      const result = await createProcessRunner().run({
        argv: GIT_STATUS_ARGV,
        cwd: ctx.cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        signal: ctx.abort,
        outputSink: createGitStatusCaptureSink(ctx.outputCapture),
      });
      const error = errorFromGitStatus(result);
      if (error) return {
        ...error,
        ...(processDetails(result) === undefined ? {} : { details: { ...error.details, process: processDetails(result)! } }),
      };
      return { isError: false, draft: { kind: "capture" }, details: { process: processDetails(result)! } };
    } catch (error) {
      return createToolErrorResult({ kind: "execution", error, message: `Failed to run git status: ${error instanceof Error ? error.message : String(error)}` });
    }
  },
});
