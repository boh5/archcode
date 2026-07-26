import type {
  DiffFile,
  ToolDiffMetadata,
  ToolDiffPresentation,
  ToolDiffUnsupportedReason,
} from "@archcode/protocol";
import {
  computeBoundedFileDiff,
  isProbablyBinaryText,
} from "./diff-computation";
import type { FileDiffResult, ToolDiffInput } from "./diff-computation";

export { isProbablyBinaryText };
export type { ToolDiffInput };

/** Maximum total characters of before+after input accepted for a tool diff. */
export const MAX_DIFF_INPUT_CHARS = 1_000_000;

/** Maximum visible hunk lines across one tool result. */
export const MAX_DIFF_OUTPUT_LINES = 2_000;

/** Maximum files represented in one tool result. */
export const MAX_DIFF_FILES = 20;

/** Deterministic edit-distance budget for detailed modified-file diffs. */
export const MAX_DIFF_EDIT_LENGTH = 1_000;

const DIFF_COMPUTATION_LIMITS = {
  maxInputChars: MAX_DIFF_INPUT_CHARS,
  maxEditLength: MAX_DIFF_EDIT_LENGTH,
} as const;

function mergeFileDiffResults(
  results: FileDiffResult[],
  exceededFileLimit: number,
): ToolDiffMetadata {
  const files: DiffFile[] = [];
  const unsupportedReasons = new Set<ToolDiffUnsupportedReason>();
  const warnings: string[] = [];
  let simplified = false;
  let truncated = exceededFileLimit > 0;

  for (const result of results) {
    if (result.file) files.push(result.file);
    if (result.unsupportedReason) unsupportedReasons.add(result.unsupportedReason);
    if (result.warning) warnings.push(result.warning);
    simplified ||= result.simplified === true;
    truncated ||= result.truncated === true;
  }

  if (exceededFileLimit > 0) {
    warnings.push(
      `Diff computation limited to ${MAX_DIFF_FILES} files; ${exceededFileLimit} file(s) skipped.`,
    );
  }

  const metadata: ToolDiffMetadata = {
    files,
    ...(simplified ? { simplified: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
  if (unsupportedReasons.size === 1 && files.length === 0) {
    metadata.unsupportedReason = [...unsupportedReasons][0];
  }
  if (warnings.length > 0) metadata.warning = warnings.join("; ");
  return metadata;
}

/** Compute a bounded structured diff for one tool-mutated file. */
export function computeToolDiff(input: ToolDiffInput): ToolDiffMetadata {
  return mergeFileDiffResults(
    [
      computeBoundedFileDiff(
        input,
        { remaining: MAX_DIFF_OUTPUT_LINES },
        DIFF_COMPUTATION_LIMITS,
      ),
    ],
    0,
  );
}

/**
 * Compute bounded structured diffs with one shared output budget.
 *
 * Once the visible-line budget is exhausted, remaining changed text files are
 * represented by file shells so the mutation list remains complete.
 */
export function computeToolDiffs(
  files: ToolDiffInput[],
  options: { readonly skippedFiles?: number } = {},
): ToolDiffMetadata {
  const limited = files.slice(0, MAX_DIFF_FILES);
  const budget = { remaining: MAX_DIFF_OUTPUT_LINES };
  const results = limited.map((file) =>
    computeBoundedFileDiff(file, budget, DIFF_COMPUTATION_LIMITS),
  );
  return mergeFileDiffResults(
    results,
    files.length - limited.length + (options.skippedFiles ?? 0),
  );
}

/** Convert internal metadata into the only diff presentation shape callers emit. */
export function createToolDiffPresentation(
  metadata: ToolDiffMetadata | undefined,
): ToolDiffPresentation | undefined {
  if (metadata === undefined || metadata.files.length === 0) return undefined;
  return {
    kind: "diff",
    files: metadata.files,
    ...(metadata.simplified ? { simplified: true } : {}),
    ...(metadata.truncated ? { truncated: true } : {}),
  };
}

export function summarizeDiffFailure(reason: ToolDiffUnsupportedReason): string {
  switch (reason) {
    case "binary":
      return "Diff not available: file appears to be binary";
    case "too_large":
      return "Diff not available: file content exceeds maximum input size";
    case "not_text":
      return "Diff not available: file is not text";
    case "no_change":
      return "No changes detected (file content is identical)";
    case "diff_error":
      return "Diff computation failed due to an internal error";
  }
}
