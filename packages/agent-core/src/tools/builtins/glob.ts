import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createRipgrepService } from "../ripgrep/service";
import type { RipgrepService } from "../ripgrep/service";
import { createWorkspacePermission } from "../permission";
import { createProcessRunner } from "../../process/runner";
import type { ProcessRunnerResult } from "../../process/types";
import type { ToolExecutionResult } from "../types";

// ─── Schema ───

export const GlobInputSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
  })
  .strict();

// ─── Service injection ───

let rgService: RipgrepService = createRipgrepService();

export function setRipgrepService(service: RipgrepService): void {
  rgService = service;
}

// ─── Tool descriptor ───

export const globTool = defineTool({
  name: "glob",
  description:
    "List files matching a glob pattern, sorted by modification time (newest first).",
  inputSchema: GlobInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  permissions: [createWorkspacePermission()],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    try {
      const rgPath = await rgService.ensure();
      const runner = createProcessRunner();

      const args: string[] = ["--files", "--glob", input.pattern, "--sortr", "modified"];
      if (input.path) {
        args.push(input.path);
      }

      const result = await runner.run({
        argv: [rgPath, ...args],
        cwd: ctx.workspaceRoot,
        env: { ...process.env },
        signal: ctx.abort,
      });

      const output = getProcessRunnerStdout(result);
      if (output.ok === false) return output.error;

      const files = output.stdout.split("\n").filter((line) => line.trim().length > 0);

      if (files.length === 0) {
        return `No files matched pattern: ${input.pattern}`;
      }

      const truncated = files.length > 100;
      const formattedOutput = files.slice(0, 100).join("\n");

      return truncated ? `${formattedOutput}\n[Output truncated: showing first 100 of ${files.length} files]` : formattedOutput;
    } catch (error) {
      return createToolErrorResult({
        kind: "glob-error",
        code: "TOOL_GLOB_ERROR",
        error: error instanceof Error ? error : new Error(String(error)),
        message: `glob failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },
});

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
          kind: "glob-error",
          code: "TOOL_GLOB_ERROR",
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
          kind: "glob-error",
          code: "TOOL_GLOB_ERROR",
          message: `rg timed out after ${result.timeoutMs}ms`,
          meta: { timeoutMs: result.timeoutMs },
        }),
      };
    case "aborted":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "glob-error",
          code: "TOOL_GLOB_ERROR",
          message: "rg was aborted",
          meta: { aborted: true },
        }),
      };
    case "signal":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "glob-error",
          code: "TOOL_GLOB_ERROR",
          message: `rg was terminated by signal ${result.signal}`,
          meta: { signal: result.signal, exitCode: result.exitCode },
        }),
      };
    case "spawn-failure":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "glob-error",
          code: "TOOL_GLOB_ERROR",
          error: new Error(result.error.message),
          message: result.error.message,
          meta: { argv: result.argv, cwd: result.cwd },
        }),
      };
  }
}
