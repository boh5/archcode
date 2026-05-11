import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createRipgrepService } from "../ripgrep/service";
import type { RipgrepService } from "../ripgrep/service";
import { createWorkspaceGuard } from "../hooks/workspace-guard";
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
  guards: [createWorkspaceGuard()],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    try {
      const rgPath = await rgService.ensure();

    const args: string[] = [
      "--files",
      "--glob",
      input.pattern,
      "--sortr",
      "modified",
    ];
    if (input.path) {
      args.push(input.path);
    }

    const proc = Bun.spawn([rgPath, ...args], {
      cwd: ctx.workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.abort,
      env: { ...process.env },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode >= 2) {
      return createToolErrorResult({
        kind: "glob-error",
        code: "TOOL_GLOB_ERROR",
        message: stderr
          ? `rg exited with code ${exitCode}: ${stderr}`
          : `rg exited with code ${exitCode}`,
        meta: { exitCode },
      });
    }

    const files = stdout.split("\n").filter((line) => line.trim().length > 0);

    if (files.length === 0) {
      return `No files matched pattern: ${input.pattern}`;
    }

    const truncated = files.length > 100;
    const result = files.slice(0, 100).join("\n");

      return truncated ? `${result}\n[Output truncated: showing first 100 of ${files.length} files]` : result;
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
