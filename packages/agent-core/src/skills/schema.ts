import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";
import type { SkillMetadata } from "./types";

export const SKILL_NAME_REGEX = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1_024;
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;
export const SKILL_FRONTMATTER_MAX_BYTES = 16 * 1024;
export const SKILL_ENTRY_MAX_BYTES = 128 * 1024;

const metadataMapSchema = z.record(z.string(), z.string());

function boundedTrimmedString(label: string, maxLength: number) {
  return z.string()
    .refine(
      (value) => Array.from(value).length <= maxLength,
      `Skill ${label} must be at most ${maxLength} characters`,
    )
    .transform((value) => value.trim())
    .pipe(z.string().min(1, `Skill ${label} must not be empty`));
}

export const SkillMetadataSchema = z.strictObject({
  name: z.string().min(1).max(SKILL_NAME_MAX_LENGTH).regex(
    SKILL_NAME_REGEX,
    "Skill name must use lowercase letters, digits, and single hyphens",
  ),
  description: boundedTrimmedString("description", SKILL_DESCRIPTION_MAX_LENGTH),
  license: z.string().trim().min(1).optional(),
  compatibility: boundedTrimmedString("compatibility", SKILL_COMPATIBILITY_MAX_LENGTH).optional(),
  metadata: metadataMapSchema.optional(),
});

export interface ParsedSkillMarkdown {
  readonly metadata: SkillMetadata;
  readonly body: string;
}

export interface ParsedSkillHeader {
  readonly metadata: SkillMetadata;
  readonly bodyOffset: number;
}

export function parseSkillFrontmatter(frontmatter: string): SkillMetadata {
  const bytes = Buffer.byteLength(frontmatter, "utf8");
  if (bytes > SKILL_FRONTMATTER_MAX_BYTES) {
    throw new Error(`Skill frontmatter exceeds ${SKILL_FRONTMATTER_MAX_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter, { maxAliasCount: 10, uniqueKeys: true });
  } catch (error) {
    throw new Error(`Invalid Skill YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Skill frontmatter must be a YAML mapping");
  }
  return SkillMetadataSchema.parse(parsed);
}

export function parseSkillHeaderBytes(content: Uint8Array): ParsedSkillHeader {
  const openingLength = openingDelimiterLength(content);
  const closing = findClosingDelimiter(content, openingLength);
  if (closing === null) {
    throw new Error(`Skill frontmatter closing delimiter was not found within ${SKILL_FRONTMATTER_MAX_BYTES} bytes`);
  }
  if (closing.frontmatterEnd - openingLength > SKILL_FRONTMATTER_MAX_BYTES) {
    throw new Error(`Skill frontmatter exceeds ${SKILL_FRONTMATTER_MAX_BYTES} bytes`);
  }

  let frontmatter: string;
  try {
    frontmatter = new TextDecoder("utf-8", { fatal: true }).decode(
      content.subarray(openingLength, closing.frontmatterEnd),
    );
  } catch {
    throw new Error("Skill frontmatter must be valid UTF-8");
  }
  return {
    metadata: parseSkillFrontmatter(frontmatter),
    bodyOffset: closing.bodyOffset,
  };
}

export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > SKILL_ENTRY_MAX_BYTES) {
    throw new Error(`SKILL.md exceeds ${SKILL_ENTRY_MAX_BYTES} bytes`);
  }
  const { metadata, bodyOffset } = parseSkillHeaderBytes(bytes);
  return {
    metadata,
    body: new TextDecoder().decode(bytes.subarray(bodyOffset)),
  };
}

export function assertSkillName(name: string): void {
  if (name.length > SKILL_NAME_MAX_LENGTH || !SKILL_NAME_REGEX.test(name)) {
    throw new Error(
      `Skill name must be 1-${SKILL_NAME_MAX_LENGTH} lowercase letters, digits, or single hyphen-separated segments: ${name}`,
    );
  }
}

function openingDelimiterLength(content: Uint8Array): number {
  if (startsWithBytes(content, [45, 45, 45, 10])) return 4;
  if (startsWithBytes(content, [45, 45, 45, 13, 10])) return 5;
  throw new Error("Skill Markdown must start with a YAML frontmatter delimiter");
}

function findClosingDelimiter(
  content: Uint8Array,
  from: number,
): { readonly frontmatterEnd: number; readonly bodyOffset: number } | null {
  let lineStart = from;
  while (lineStart <= content.byteLength) {
    let lineEnd = lineStart;
    while (lineEnd < content.byteLength && content[lineEnd] !== 10 && content[lineEnd] !== 13) {
      lineEnd += 1;
    }
    if (
      lineEnd - lineStart === 3
      && content[lineStart] === 45
      && content[lineStart + 1] === 45
      && content[lineStart + 2] === 45
    ) {
      let bodyOffset = lineEnd;
      if (content[bodyOffset] === 13) bodyOffset += 1;
      if (content[bodyOffset] === 10) bodyOffset += 1;
      return { frontmatterEnd: lineStart, bodyOffset };
    }
    if (lineEnd >= content.byteLength) return null;
    lineStart = lineEnd + (content[lineEnd] === 13 && content[lineEnd + 1] === 10 ? 2 : 1);
  }
  return null;
}

function startsWithBytes(content: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => content[index] === byte);
}
