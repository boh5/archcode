import { z } from "zod";
import { TOOL_COMPRESS } from "../names";
import { defineTool } from "../define-tool";
import type { RawToolResult } from "../types";
import { createTextToolResult } from "../results";
import {
  COMPRESS_TOOL_TRAITS,
  COMPRESSION_SUMMARY_SECTION_NAMES,
  prepareDynamicRangeCompression,
} from "../../compression";
import type { CompressionSummarySectionName } from "../../compression";

const COMPRESSION_SECTION_DESCRIPTIONS = {
  "Current Objective": "Active objective and intended outcome.",
  "User Constraints": "User constraints that remain in force.",
  "Decisions Made": "Settled decisions and essential rationale.",
  "Open Tasks": "Unfinished work, pending decisions, and verification.",
  "Important Files": "Files and code locations needed to continue.",
  "Tool Results": "Material completed tool results needed later.",
  "Errors/Unknown Results": "Failures, uncertainties, and unconfirmed results.",
  "Protected Refs": "Visible or protected projection refs and their relevance.",
  "Child Block Refs": "Nested block refs consumed and what each contributes.",
  "Resume Instructions": "Concrete next actions for resuming work.",
} satisfies Record<CompressionSummarySectionName, string>;

const CompressionSummarySectionsSchema = z.strictObject(
  Object.fromEntries(
    COMPRESSION_SUMMARY_SECTION_NAMES.map((section) => [
      section,
      z.string().min(1).describe(COMPRESSION_SECTION_DESCRIPTIONS[section]),
    ]),
  ) as Record<(typeof COMPRESSION_SUMMARY_SECTION_NAMES)[number], z.ZodString>,
);

export const CompressInputSchema = z.strictObject({
  startId: z.string().describe("Projection start ref, e.g. m0001 or a known block ref like b1."),
  endId: z.string().describe("Projection end ref, e.g. m0004 or a known block ref like b1."),
  summary: z.strictObject({
    sections: CompressionSummarySectionsSchema
      .describe("All ten required semantic sections that preserve the compressed range's continuation context. If the range contains active compression blocks, place each required (bN) placeholder exactly once where that block's complete stored summary should be inserted. The runtime derives the required child refs."),
  }).describe("Strict structured compression summary template. A (bN) placeholder represents the complete previously compressed conversation segment and surrounding text must remain coherent after expansion."),
});

export type CompressInput = z.infer<typeof CompressInputSchema>;

export const compressTool = defineTool({
  name: TOOL_COMPRESS,
  description:
    "Reduce conversation context by compacting an earlier visible model history range through projection refs. Previously compressed blocks inside the range are materialized into the new summary before commit, while canonical transcript text remains unchanged.",
  inputSchema: CompressInputSchema,
  traits: COMPRESS_TOOL_TRAITS,
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute(input, ctx): RawToolResult {
    const result = prepareDynamicRangeCompression(ctx.store.getState(), input);
    ctx.store.getState().append(result.event);

    if (!result.ok) {
      return createTextToolResult(JSON.stringify({
          ok: false,
          code: result.code,
          reason: result.reason,
          issues: result.issues,
          protectedRefs: result.protectedRefs,
        }));
    }

    return createTextToolResult(JSON.stringify({
        ok: true,
        blockRef: result.block.ref,
        startRef: result.block.range.startRef,
        endRef: result.block.range.endRef,
        childBlockRefs: result.block.childBlockRefs,
        deduplicatedToolOutputs: result.deduplicatedToolOutputs,
        purgedErrors: result.purgedErrors,
      }));
  },
});
