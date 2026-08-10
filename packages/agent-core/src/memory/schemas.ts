import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Enum / union helpers
// ---------------------------------------------------------------------------

export const MEMORY_TOPIC_VALUES = ["user", "feedback", "project", "reference"] as const;

/** Zod enum matching MemoryTopicType */
export const MemoryTopicTypeSchema = z.enum(MEMORY_TOPIC_VALUES);

const SingleLineMetadataSchema = z.string().refine(
  (value) => !/[\r\n]/.test(value),
  "Memory topic metadata must be a single line",
);

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Schema for YAML frontmatter in topic files */
export const MemoryFrontmatterSchema = z.strictObject({
  name: SingleLineMetadataSchema,
  description: SingleLineMetadataSchema,
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

/** Schema for LLM title-generation output (T9/T12) */
export const TitleGenerationResultSchema = z.strictObject({
  title: z.string().max(200),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;
export type TitleGenerationResult = z.infer<typeof TitleGenerationResultSchema>;
