import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createRipgrepService } from "../ripgrep/service";
import type { RipgrepService } from "../ripgrep/service";
import { createWorkspaceGuard } from "../hooks/read-snapshot";
import { buildFileListArgs, buildCountArgs, buildSearchArgs, formatSearchResult, parseRgOutput } from "../ripgrep/search";
import type { ToolExecutionResult } from "../types";

// ─── Schema ───

export const GrepInputSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
    include: z.string().optional(),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    context: z.number().optional(),
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
  guards: [createWorkspaceGuard()],
  async execute(input, ctx): Promise<string | ToolExecutionResult> {
    try {
      const rgPath = await rgService.ensure();
      const outputMode = input.output_mode ?? "content";

    if (outputMode === "files_with_matches") {
      const args = buildFileListArgs(input.pattern, input.include, input.path);
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
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          message: stderr
            ? `rg exited with code ${exitCode}: ${stderr}`
            : `rg exited with code ${exitCode}`,
          meta: { exitCode },
        });
      }

      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        return `No matches found for pattern: ${input.pattern}`;
      }

      const truncated = lines.length > 100;
      const display = truncated ? lines.slice(0, 100) : lines;
      let result = display.join("\n");
      if (truncated) {
        result += "\n[Output truncated: showing first 100 files]";
      }
      return result;
    }

    if (outputMode === "count") {
      const args = buildCountArgs(input.pattern, input.include, input.path);
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
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          message: stderr
            ? `rg exited with code ${exitCode}: ${stderr}`
            : `rg exited with code ${exitCode}`,
          meta: { exitCode },
        });
      }

      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        return `No matches found for pattern: ${input.pattern}`;
      }

      const truncated = lines.length > 100;
      const display = truncated ? lines.slice(0, 100) : lines;
      let result = display.join("\n");
      if (truncated) {
        result += "\n[Output truncated: showing first 100 files]";
      }
      return result;
    }

    // Content mode — use --json parsing for structured output
    const searchArgs = {
      pattern: input.pattern,
      path: input.path,
      include: input.include,
      context: input.context,
    };

    const args = buildSearchArgs(searchArgs, rgPath);

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
        kind: "grep-error",
        code: "TOOL_GREP_ERROR",
        message: stderr
          ? `rg exited with code ${exitCode}: ${stderr}`
          : `rg exited with code ${exitCode}`,
        meta: { exitCode },
      });
    }

    const result = parseRgOutput(stdout, 100);

    if (result.matches.length === 0) {
      return `No matches found for pattern: ${input.pattern}`;
    }

    const formatted = formatSearchResult(result, "content");

    if (result.truncated) {
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
