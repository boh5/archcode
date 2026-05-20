import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Enum / union helpers
// ---------------------------------------------------------------------------

export const MEMORY_TOPIC_VALUES = ["user", "feedback", "project", "reference"] as const;

/** Zod enum matching MemoryTopicType */
export const MemoryTopicTypeSchema = z.enum(MEMORY_TOPIC_VALUES);

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Schema for YAML frontmatter in topic files */
export const MemoryFrontmatterSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  type: MemoryTopicTypeSchema,
});

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/** Validates a single line of index.md in `- [Title](name) — summary` format */
export const MemoryIndexLineSchema = z.string().regex(
  /^- \[.+?\]\(.+?\) — .+$/,
  "Index line must match format: - [Title](name) — summary",
);

// ---------------------------------------------------------------------------
// Background task result schemas (used with generateObject)
// ---------------------------------------------------------------------------

/** Schema for LLM memory-extraction output (T11) */
export const MemoryExtractionResultSchema = z.strictObject({
  memories: z
    .array(
      z.strictObject({
        title: z.string().max(100),
        name: z.string().max(200),
        description: z.string().max(300),
        type: MemoryTopicTypeSchema,
        content: z.string().max(4000),
        shouldCreate: z.boolean(),
      }),
    )
    .max(10),
});

/** Schema for LLM memory-consolidation output (T13) */
export const MemoryConsolidationResultSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        title: z.string().max(100),
        name: z.string().max(200),
        summary: z.string().max(300),
      }),
    )
    .max(200),
});

/** Schema for LLM title-generation output (T9/T12) */
export const TitleGenerationResultSchema = z.strictObject({
  title: z.string().max(200),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;
export type MemoryExtractionResult = z.infer<typeof MemoryExtractionResultSchema>;
export type MemoryConsolidationResult = z.infer<typeof MemoryConsolidationResultSchema>;
export type TitleGenerationResult = z.infer<typeof TitleGenerationResultSchema>;
