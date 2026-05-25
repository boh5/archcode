import { z } from "zod/v4";
import { parseFrontmatter as parseGenericFrontmatter } from "../utils/frontmatter";
import type { SkillMetadata } from "./types";

export const SKILL_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const allowedToolsSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return [];
  const unwrapped = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return unwrapped
    .split(",")
    .map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter((item) => item.length > 0);
}, z.array(z.string().min(1)));

export const SkillMetadataSchema = z.strictObject({
  name: z.string().regex(SKILL_NAME_REGEX, "Skill name must match ^[a-z0-9][a-z0-9-]*$"),
  description: z.string().min(1),
  allowed_tools: allowedToolsSchema.optional(),
});

export type ParsedSkillMetadata = z.infer<typeof SkillMetadataSchema>;

export function parseSkillMarkdown(content: string): {
  metadata: SkillMetadata;
  body: string;
} {
  const { frontmatter, body } = parseGenericFrontmatter(content);
  const metadata = SkillMetadataSchema.parse(frontmatter);
  return { metadata, body };
}

export function assertSkillName(name: string): void {
  if (!SKILL_NAME_REGEX.test(name)) {
    throw new Error(`Skill name must match ^[a-z0-9][a-z0-9-]*$: ${name}`);
  }
}
