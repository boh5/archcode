import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createRipgrepService } from "../ripgrep/service";
import type { RipgrepService } from "../ripgrep/service";
import { createWorkspacePermission } from "../permission";
import { createProcessRunner } from "../../process/runner";
import type { ProcessRunnerResult } from "../../process/types";
import { buildFileListArgs, buildCountArgs, buildSearchArgs, parseRgJsonLine } from "../ripgrep/search";
import type { RawToolResult } from "../types";
import { createLineSourcePage } from "./source-page";
import { createBoundedSourceLineSink } from "./bounded-source-sink";

// ─── Schema ───

export const GrepInputSchema = z
  .object({
    pattern: z.string().describe("Ripgrep regular expression to search for in file contents, for example `defineTool\\(` or `class\\s+ToolRegistry`."),
    path: z.string().optional().describe("File or directory to search, absolute or relative to the current Session cwd. Defaults to the Session cwd."),
    include: z.string().optional().describe("File-name glob used to filter searched files, for example `*.ts` or `*.{ts,tsx}`."),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("`content` returns matching lines, `files_with_matches` returns paths only, and `count` returns per-file counts. Default `content`. At most 100 entries are returned."),
    context: z.number().optional().describe("Number of lines before and after each match. Used only with output_mode `content`."),
    offset: z.number().int().nonnegative().default(0).describe("Strictly forward result offset from a prior page. Results are re-evaluated, so snapshot is false."),
    limit: z.number().int().min(1).max(1_000).default(100).describe("Maximum sorted records requested for this page; the 50 KiB/2,000-line source cap may return fewer."),
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
  description: [
    "Search file contents with ripgrep regular expressions. Prefer this tool to `rg` or `grep` through bash. Use glob when searching for file names rather than contents.",
    "",
    "Typical workflow: locate candidate content with `grep({\"pattern\":\"defineTool\\\\(\",\"path\":\"packages/agent-core/src\",\"include\":\"*.ts\",\"output_mode\":\"content\",\"context\":2})`, then use file_read on the returned paths and line ranges. Use `files_with_matches` to obtain only paths and `count` for per-file counts. Results are limited to the first 100 entries, so narrow path/include/pattern and retry when the result is truncated.",
    "",
    "If the investigation is open-ended across unknown modules and will require repeated rounds of searching, delegate one concrete research question to Explore when delegate is available instead of manually reproducing the same exploration loop.",
  ].join("\n"),
  inputSchema: GrepInputSchema,
  traits: {
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
  },
  outputPolicy: { kind: "source", previewDirection: "head" },
  permissions: [createWorkspacePermission()],
  async execute(input, ctx): Promise<RawToolResult> {
    try {
      const rgPath = await rgService.ensure();
      const outputMode = input.output_mode ?? "content";
      const runner = createProcessRunner();

      const runRg = async (args: string[], sink?: import("../../process/types").ProcessOutputSink) => {
        return runner.run({
          argv: [rgPath, ...args],
          cwd: ctx.cwd,
          env: { ...process.env },
          signal: ctx.abort,
          ...(sink === undefined ? {} : { outputSink: sink }),
        });
      };

      if (outputMode === "files_with_matches") {
        const collector = createBoundedSourceLineSink(input.offset, input.limit, (line) => line.trim() || undefined);
        const result = await runRg(buildFileListArgs(input.pattern, input.include, input.path), collector.sink);
        const output = getProcessRunnerStdout(result);
        if (output.ok === false) return output.error;
        return formatCollectedPage(result, collector.finish(), input);
      }

      if (outputMode === "count") {
        const collector = createBoundedSourceLineSink(input.offset, input.limit, (line) => line.trim() || undefined);
        const result = await runRg(buildCountArgs(input.pattern, input.include, input.path), collector.sink);
        const output = getProcessRunnerStdout(result);
        if (output.ok === false) return output.error;
        return formatCollectedPage(result, collector.finish(), input);
      }

      const searchArgs = {
        pattern: input.pattern,
        path: input.path,
        include: input.include,
        context: input.context,
      };

      const collector = createBoundedSourceLineSink(input.offset, input.limit, (line) => {
        const match = parseRgJsonLine(line);
        return match === null ? undefined : `${match.path}:${match.lineNumber}:${match.content}`;
      });
      const result = await runRg(buildSearchArgs(searchArgs), collector.sink);
      const output = getProcessRunnerStdout(result);
      if (output.ok === false) return output.error;

      const lines = collector.finish();
      if (lines.length === 0) {
        return createLineSourcePage({ lines: [], offset: 0, nextInput: () => input, emptyText: `No matches found for pattern: ${input.pattern}` });
      }

      return createGrepPage(lines, input, true);
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

function formatCollectedPage(result: ProcessRunnerResult, lines: readonly string[], input: z.infer<typeof GrepInputSchema>): RawToolResult {
  const output = getProcessRunnerStdout(result);
  if (output.ok === false) return output.error;
  if (lines.length === 0) {
    return createLineSourcePage({ lines: [], offset: 0, nextInput: () => input, emptyText: `No matches found for pattern: ${input.pattern}` });
  }
  return createGrepPage(lines, input, true);
}

function createGrepPage(lines: readonly string[], input: z.infer<typeof GrepInputSchema>, alreadyPaged = false): RawToolResult {
  const remaining = alreadyPaged ? lines : lines.slice(input.offset);
  return createLineSourcePage({
    lines: ["snapshot: false", ...remaining],
    offset: 0,
    recordLimit: input.limit + 1,
    emptyText: `No matches found for pattern: ${input.pattern}`,
    nextInput: (consumed) => ({ ...input, offset: input.offset + Math.max(0, consumed - 1) }),
  });
}

function getProcessRunnerStdout(
  result: ProcessRunnerResult,
): { ok: true; stdout: string } | { ok: false; error: RawToolResult } {
  if (result.kind !== "spawn-failure" && result.output.sinkStatus === "discarded") {
    return {
      ok: false,
      error: createToolErrorResult({
        kind: "grep-error",
        code: "TOOL_GREP_ERROR",
        message: "rg source collection failed before a complete bounded page was available",
      }),
    };
  }
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
        }),
      };
    case "timeout":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          message: `rg timed out after ${result.timeoutMs}ms`,
        }),
      };
    case "aborted":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          message: "rg was aborted",
        }),
      };
    case "signal":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "grep-error",
          code: "TOOL_GREP_ERROR",
          message: `rg was terminated by signal ${result.signal}`,
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
        }),
      };
  }
}
