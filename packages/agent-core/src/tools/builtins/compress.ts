import { z } from "zod";
import { TOOL_COMPRESS } from "../names";
import { defineTool } from "../define-tool";
import type { ToolExecutionResult } from "../types";
import {
  COMPRESS_TOOL_TRAITS,
  COMPRESSION_SUMMARY_SECTION_NAMES,
  prepareDynamicRangeCompression,
} from "../../compression";

const CompressionSummarySectionsSchema = z.strictObject(
  Object.fromEntries(
    COMPRESSION_SUMMARY_SECTION_NAMES.map((section) => [section, z.string().min(1)]),
  ) as Record<(typeof COMPRESSION_SUMMARY_SECTION_NAMES)[number], z.ZodString>,
);

export const CompressInputSchema = z.strictObject({
  startId: z.string().describe("Projection start ref, e.g. m0001 or a known block ref like b1."),
  endId: z.string().describe("Projection end ref, e.g. m0004 or a known block ref like b1."),
  summary: z.strictObject({
    version: z.literal(1),
    sections: CompressionSummarySectionsSchema,
    childBlockRefs: z.array(z.string().regex(/^b\d+$/)).describe("Nested child block refs that this summary consumes."),
  }).describe("Strict structured compression summary with all required sections."),
});

export type CompressInput = z.infer<typeof CompressInputSchema>;

export const compressTool = defineTool({
  name: TOOL_COMPRESS,
  description:
    "Compresses a visible transcript range by projection refs. Validates the model-authored structured summary and commits compression metadata without changing canonical transcript text.",
  inputSchema: CompressInputSchema,
  traits: COMPRESS_TOOL_TRAITS,
  execute(input, ctx): ToolExecutionResult {
    const result = prepareDynamicRangeCompression(ctx.store.getState(), input);
    ctx.store.getState().append(result.event);

    if (!result.ok) {
      return {
        output: JSON.stringify({
          ok: false,
          code: result.code,
          reason: result.reason,
          issues: result.issues,
          protectedRefs: result.protectedRefs,
        }),
        isError: false,
        meta: {
          compression: {
            ok: false,
            code: result.code,
            protectedRefs: result.protectedRefs,
          },
        },
      };
    }

    return {
      output: JSON.stringify({
        ok: true,
        blockRef: result.block.ref,
        startRef: result.block.range.startRef,
        endRef: result.block.range.endRef,
        childBlockRefs: result.block.childBlockRefs,
        deduplicatedToolOutputs: result.deduplicatedToolOutputs,
        purgedErrors: result.purgedErrors,
      }),
      isError: false,
      meta: {
        compression: {
          ok: true,
          blockRef: result.block.ref,
          activeBlockRefs: result.state.activeBlockRefs,
          supersededBlockRefs: result.state.supersededBlockRefs,
        },
      },
    };
  },
});
