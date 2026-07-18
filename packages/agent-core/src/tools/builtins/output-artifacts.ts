import { z } from "zod";

import { ToolOutputError, isToolOutputError } from "../../tool-output/errors";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createSourceToolResult } from "../results";
import type { RawToolResult, ToolExecutionContext } from "../types";

const patternBytes = (value: string) => new TextEncoder().encode(value).byteLength <= 1024;
const encoder = new TextEncoder();
const SOURCE_RESULT_MAX_BYTES = 50 * 1024;
const OUTPUT_READ_CONTENT_BUDGET = 42 * 1024;
const OUTPUT_READ_RECORD_LIMIT = 32;
const OUTPUT_SEARCH_CONTENT_BUDGET = 36 * 1024;

export const OutputReadInputSchema = z.object({
  outputRef: z.string().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1_000).default(200),
}).strict();

export const OutputSearchInputSchema = z.object({
  outputRef: z.string().min(1).optional(),
  pattern: z.string().min(1).refine(patternBytes, "pattern must be at most 1 KiB UTF-8"),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export const outputReadTool = defineTool({
  name: "output_read",
  description: "Read a bounded page from a recoverable tool-output artifact. The result explicitly labels each full/head/tail segment, canonical range, gap, and artifact completeness; never treat head and tail as adjacent. Continue only with the returned opaque cursor, which is bound to this Session family and outputRef.",
  inputSchema: OutputReadInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "source", previewDirection: "head" },
  async execute(input, ctx): Promise<RawToolResult> {
    if (ctx.outputArtifacts === undefined) return unavailable();
    try {
      const page = await ctx.outputArtifacts.read({
        ...input,
        limit: Math.min(input.limit, OUTPUT_READ_RECORD_LIMIT),
        maxContentBytes: OUTPUT_READ_CONTENT_BUDGET,
      });
      const gap = page.gap === undefined
        ? "none"
        : `${page.gap.canonicalStart}-${page.gap.canonicalEnd}`;
      const records = page.records.map((record) => (
        `[record segment=${record.segment} range=${record.canonicalStart}-${record.canonicalEnd} continuedFromPrevious=${record.continuedFromPrevious} continuesNext=${record.continuesNext}]\n${record.text}${record.text.endsWith("\n") ? "" : "\n"}`
      )).join("");
      const text = assertSourceBudget(
        `[artifact outputRef=${page.outputRef} completeness=${page.completeness} gap=${gap} records=${page.records.length}]\n${records}`,
      );
      return createSourceToolResult(
        text,
        page.nextCursor === undefined
          ? undefined
          : { outputRef: input.outputRef, cursor: page.nextCursor, limit: input.limit },
      );
    } catch (error) {
      return artifactError(error);
    }
  },
});

export const outputSearchTool = defineTool({
  name: "output_search",
  description: "Search one recoverable output artifact by outputRef, or omit outputRef to search this Session family. The result explicitly labels searchCompleteness and every match's full/head/tail segment and canonical range; partial_artifact means omitted bytes were not searched, including when matches is empty. Continue only with the returned opaque cursor.",
  inputSchema: OutputSearchInputSchema,
  traits: { readOnly: true, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "source", previewDirection: "head" },
  async execute(input, ctx): Promise<RawToolResult> {
    if (ctx.outputArtifacts === undefined) return unavailable();
    try {
      const page = await ctx.outputArtifacts.search({
        ...input,
        maxContentBytes: OUTPUT_SEARCH_CONTENT_BUDGET,
      });
      const matches = page.matches.map((match) => (
        `[match outputRef=${match.outputRef} segment=${match.segment} range=${match.canonicalStart}-${match.canonicalEnd}]\n${match.snippet}\n`
      )).join("");
      const text = assertSourceBudget(
        `[search scope=${input.outputRef ?? "family"} searchCompleteness=${page.searchCompleteness} matches=${page.matches.length}]\n${matches}`,
      );
      return createSourceToolResult(
        text,
        page.nextCursor === undefined
          ? undefined
          : {
              ...(input.outputRef === undefined ? {} : { outputRef: input.outputRef }),
              pattern: input.pattern,
              cursor: page.nextCursor,
              limit: input.limit,
            },
      );
    } catch (error) {
      return artifactError(error);
    }
  },
});

function unavailable(): RawToolResult {
  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_OUTPUT_UNAVAILABLE",
    message: "Tool output access is unavailable",
  });
}

function artifactError(error: unknown): RawToolResult {
  if (isToolOutputError(error)) {
    return createToolErrorResult({ kind: "execution", code: error.code, name: error.name, message: error.message });
  }
  return createToolErrorResult({ kind: "execution", code: "TOOL_OUTPUT_UNAVAILABLE", error });
}

function assertSourceBudget(text: string): string {
  if (encoder.encode(text).byteLength > SOURCE_RESULT_MAX_BYTES) {
    throw new ToolOutputError(
      "TOOL_OUTPUT_POLICY_VIOLATION",
      "Tool output recovery envelope exceeded its source-page budget",
    );
  }
  return text;
}
