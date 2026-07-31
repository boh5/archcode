export const COMPRESSION_SUMMARY_SECTION_NAMES = [
  "Current Objective",
  "User Constraints",
  "Decisions Made",
  "Open Tasks",
  "Important Files",
  "Tool Results",
  "Errors/Unknown Results",
  "Protected Refs",
  "Child Block Refs",
  "Resume Instructions",
] as const;

export type CompressionSummarySectionName =
  (typeof COMPRESSION_SUMMARY_SECTION_NAMES)[number];

export interface CompressionSummarySnapshot {
  sections: Record<CompressionSummarySectionName, string>;
}

export function renderCompressionSummarySnapshot(
  summary: CompressionSummarySnapshot,
): string {
  return COMPRESSION_SUMMARY_SECTION_NAMES
    .map((section) => `## ${section}\n${summary.sections[section]}`)
    .join("\n\n");
}

export function isMaterializedCompressionSummarySnapshot(
  summary: CompressionSummarySnapshot,
): boolean {
  return COMPRESSION_SUMMARY_SECTION_NAMES.every((section) => {
    const content = summary.sections[section];
    return content.length > 0 && !/\(b\d+\)/.test(content);
  });
}
