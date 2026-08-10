import { SKILL_PROMPT_MAX_BYTES } from "@archcode/protocol";
import type { SkillIndexEntry, SkillPromptProjection } from "./types";

export { SKILL_PROMPT_MAX_BYTES };
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
  const lines = normalized.map((entry) =>
    `- ${entry.name}: ${entry.description} (source=${entry.source})`
  );
  let prefixBytes = 0;
  let bestIncludedCount: number | undefined;
  for (let includedCount = 0; includedCount <= normalized.length; includedCount += 1) {
    if (includedCount > 0) {
      prefixBytes += Buffer.byteLength(lines[includedCount - 1]!, "utf8");
      if (includedCount > 1) prefixBytes += 1;
    }
    const omittedCount = normalized.length - includedCount;
    const bodyBytes = includedCount === 0 ? Buffer.byteLength("- none", "utf8") : prefixBytes;
    const footerBytes = omittedCount === 0
      ? 0
      : 1 + Buffer.byteLength(renderOmissionFooter(omittedCount), "utf8");
    if (bodyBytes + footerBytes <= maxBytes) bestIncludedCount = includedCount;
  }
  if (bestIncludedCount === undefined) {
    throw new Error(`Skill projection fixed text exceeds ${maxBytes} UTF-8 bytes`);
  }
  const includedEntries = Object.freeze(normalized.slice(0, bestIncludedCount));
  const omittedCount = normalized.length - bestIncludedCount;
  const renderedText = renderProjection(includedEntries, omittedCount);
  return Object.freeze({
    includedEntries,
    omittedCount,
    renderedText,
    byteLength: Buffer.byteLength(renderedText, "utf8"),
  });
}

export function normalizeSkillDescription(description: string): string {
  return truncateUtf8(normalizeWhitespace(description), SKILL_PROMPT_DESCRIPTION_MAX_BYTES);
}

function renderProjection(entries: readonly SkillIndexEntry[], omittedCount: number): string {
  const lines = entries.length === 0
    ? ["- none"]
    : entries.map((entry) => `- ${entry.name}: ${entry.description} (source=${entry.source})`);
  if (omittedCount > 0) lines.push(renderOmissionFooter(omittedCount));
  return lines.join("\n");
}

function renderOmissionFooter(omittedCount: number): string {
  const noun = omittedCount === 1 ? "Skill" : "Skills";
  return `- ${omittedCount} additional ${noun} omitted; use skill_list to continue discovery.`;
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
