import type { SkillIndexEntry, SkillPromptProjection } from "./types";

export const SKILL_PROMPT_MAX_BYTES = 8_000;
export const SKILL_PROMPT_DESCRIPTION_MAX_BYTES = 160;
const ELLIPSIS = "…";

export function projectAvailableSkills(
  entries: readonly SkillIndexEntry[],
  maxBytes = SKILL_PROMPT_MAX_BYTES,
): SkillPromptProjection {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Skill projection maxBytes must be non-negative");
  const normalized = entries.map((entry) => Object.freeze({
    ...entry,
    description: truncateUtf8(normalizeWhitespace(entry.description), SKILL_PROMPT_DESCRIPTION_MAX_BYTES),
  }));
  let includedCount = normalized.length;
  while (includedCount >= 0) {
    const includedEntries = Object.freeze(normalized.slice(0, includedCount));
    const omittedCount = normalized.length - includedCount;
    const renderedText = renderProjection(includedEntries, omittedCount);
    const byteLength = Buffer.byteLength(renderedText, "utf8");
    if (byteLength <= maxBytes) {
      return Object.freeze({ includedEntries, omittedCount, renderedText, byteLength });
    }
    includedCount -= 1;
  }
  throw new Error(`Skill projection fixed text exceeds ${maxBytes} UTF-8 bytes`);
}

export function normalizeSkillDescription(description: string): string {
  return truncateUtf8(normalizeWhitespace(description), SKILL_PROMPT_DESCRIPTION_MAX_BYTES);
}

function renderProjection(entries: readonly SkillIndexEntry[], omittedCount: number): string {
  const lines = entries.length === 0
    ? ["- none"]
    : entries.map((entry) => `- ${entry.name}: ${entry.description} (source=${entry.source})`);
  if (omittedCount > 0) lines.push(`- ${omittedCount} additional Skills omitted; use skill_list to continue discovery.`);
  return lines.join("\n");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const ellipsisBytes = Buffer.byteLength(ELLIPSIS, "utf8");
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size + ellipsisBytes > maxBytes) break;
    result += character;
    bytes += size;
  }
  return `${result}${ELLIPSIS}`;
}
