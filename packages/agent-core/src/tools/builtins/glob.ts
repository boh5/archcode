import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createRipgrepService } from "../ripgrep/service";
import type { RipgrepService } from "../ripgrep/service";
import { createWorkspacePermission } from "../permission";
import { createProcessRunner } from "../../process/runner";
import type { ProcessRunnerResult } from "../../process/types";
import type { RawToolResult } from "../types";
import { createLineSourcePage } from "./source-page";
import { createBoundedSourceLineSink } from "./bounded-source-sink";

// ─── Schema ───

export const GlobInputSchema = z
  .object({
    pattern: z.string().describe("Glob pattern for file paths, for example `**/*.ts` or `src/**/*.json`."),
    path: z.string().optional().describe("Directory to search, absolute or relative to the current Session cwd. Defaults to the Session cwd."),
    offset: z.number().int().nonnegative().default(0).describe("Strictly forward path offset from a prior page. Results are re-evaluated, so snapshot is false."),
    limit: z.number().int().min(1).max(1_000).default(100).describe("Maximum sorted paths requested for this page; the 50 KiB/2,000-line source cap may return fewer."),
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
  description: [
    "Find files by file-name or path glob pattern, not by file contents. Use grep for content searches.",
    "",
    "Example: `glob({\"pattern\":\"**/*.test.ts\",\"path\":\"packages/agent-core\"})`. A common discovery chain is glob for candidate paths -> grep for matching content -> file_read for exact context. Results are sorted by path and paged with a strictly increasing offset. Each page states `snapshot: false` because the filesystem is re-evaluated.",
    "",
    "If the search is open-ended and needs repeated glob/grep/read rounds across unknown modules, delegate one concrete question to Explore when delegate is available.",
  ].join("\n"),
  inputSchema: GlobInputSchema,
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
      const runner = createProcessRunner();

      const args: string[] = ["--files", "--sort", "path", "--glob", input.pattern];
      if (input.path) {
        args.push(input.path);
      }

      const collector = createBoundedSourceLineSink(input.offset, input.limit, (line) => line.trim() || undefined);
      const result = await runner.run({
        argv: [rgPath, ...args],
        cwd: ctx.cwd,
        env: { ...process.env },
        signal: ctx.abort,
        outputSink: collector.sink,
      });

      const output = getProcessRunnerStdout(result);
      if (output.ok === false) return output.error;
      const files = collector.finish();

      if (files.length === 0) {
        return createLineSourcePage({ lines: [], offset: 0, nextInput: () => input, emptyText: `No files matched pattern: ${input.pattern}` });
      }

      return createLineSourcePage({
        lines: ["snapshot: false", ...files],
        offset: 0,
        recordLimit: input.limit + 1,
        emptyText: `No files matched pattern: ${input.pattern}`,
        nextInput: (consumed) => ({ ...input, offset: input.offset + Math.max(0, consumed - 1) }),
      });
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
): { ok: true; stdout: string } | { ok: false; error: RawToolResult } {
  if (result.kind !== "spawn-failure" && result.output.sinkStatus === "discarded") {
    return {
      ok: false,
      error: createToolErrorResult({
        kind: "glob-error",
        code: "TOOL_GLOB_ERROR",
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
          kind: "glob-error",
          code: "TOOL_GLOB_ERROR",
          message: result.output.stderr
            ? `rg exited with code ${result.exitCode}: ${result.output.stderr}`
            : `rg exited with code ${result.exitCode}`,
        }),
      };
    case "timeout":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "glob-error",
          code: "TOOL_GLOB_ERROR",
          message: `rg timed out after ${result.timeoutMs}ms`,
        }),
      };
    case "aborted":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "glob-error",
          code: "TOOL_GLOB_ERROR",
          message: "rg was aborted",
        }),
      };
    case "signal":
      return {
        ok: false,
        error: createToolErrorResult({
          kind: "glob-error",
          code: "TOOL_GLOB_ERROR",
          message: `rg was terminated by signal ${result.signal}`,
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
        }),
      };
  }
}
