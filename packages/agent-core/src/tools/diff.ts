import { structuredPatch } from "diff";
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  ToolDiffMetadata,
  ToolDiffUnsupportedReason,
} from "@archcode/protocol";

// ── Constants ──────────────────────────────────────────────────────────────

/** Maximum total characters of before+after input allowed for diff computation. */
export const MAX_DIFF_INPUT_CHARS = 1_000_000;

/** Maximum total diff output lines (hunk lines across all files) before truncation. */
export const MAX_DIFF_OUTPUT_LINES = 2_000;

/** Maximum number of files to compute diffs for in a single batch. */
export const MAX_DIFF_FILES = 20;

// ── Binary detection ───────────────────────────────────────────────────────

/**
 * Check whether a string is probably binary content.
 *
 * Returns `true` if the text contains NUL bytes or has a high ratio (>30%)
 * of non-printable characters (control characters excluding common whitespace
 * like tab, newline, carriage return) in the first 1000 bytes.
 */
export function isProbablyBinaryText(text: string): boolean {
  if (text.includes("\0")) return true;

  const sampleLen = Math.min(text.length, 1000);
  let nonPrintable = 0;
  for (let i = 0; i < sampleLen; i++) {
    const code = text.charCodeAt(i);
    // Allowable: tab (9), lf (10), cr (13), printable ASCII (32-126), unicode (128+)
    if ((code > 0 && code < 8) || (code > 13 && code < 32) || code === 11 || code === 12) {
      nonPrintable++;
    }
  }
  return nonPrintable > sampleLen * 0.3;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function buildHunkHeader(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
): string {
  const oldPart = oldLines === 1 ? `-${oldStart}` : `-${oldStart},${oldLines}`;
  const newPart = newLines === 1 ? `+${newStart}` : `+${newStart},${newLines}`;
  return `@@ ${oldPart} ${newPart} @@`;
}

function parseHunkLines(lines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  for (const line of lines) {
    if (line.startsWith("\\")) continue; // "No newline at end of file"
    const prefix = line[0] as " " | "+" | "-";
    const content = line.slice(1);
    if (prefix === " ") result.push({ type: "context", content });
    else if (prefix === "+") result.push({ type: "add", content });
    else if (prefix === "-") result.push({ type: "delete", content });
  }
  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute a structured diff for a single file.
 *
 * Auto-detects status: if `before` is empty → `"created"`, otherwise → `"modified"`.
 * An explicit `status` parameter overrides auto-detection.
 *
 * Returns `ToolDiffMetadata` with unsupported reasons for binary, too-large,
 * identical, or error cases — never throws.
 */
export function computeToolDiff({
  path,
  before,
  after,
  status,
}: {
  path: string;
  before: string;
  after: string;
  status?: "created" | "modified" | "deleted";
}): ToolDiffMetadata {
  try {
    // ── Guard: identical content ───────────────────────────────────────────
    if (before === after) {
      return { version: 1, files: [], unsupportedReason: "no_change" };
    }

    // ── Guard: binary content ─────────────────────────────────────────────
    if (isProbablyBinaryText(before) || isProbablyBinaryText(after)) {
      return { version: 1, files: [], unsupportedReason: "binary" };
    }

    // ── Guard: input too large ────────────────────────────────────────────
    if (before.length + after.length > MAX_DIFF_INPUT_CHARS) {
      return { version: 1, files: [], unsupportedReason: "too_large" };
    }

    // ── Resolve file status ───────────────────────────────────────────────
    const fileStatus: "created" | "modified" | "deleted" =
      status ?? (before === "" ? "created" : "modified");

    // ── Compute diff via jsdiff ───────────────────────────────────────────
    const patch = structuredPatch(path, path, before, after);

    const hunks: DiffHunk[] = [];
    let totalLines = 0;
    let truncated = false;

    for (const hunk of patch.hunks) {
      const lines = parseHunkLines(hunk.lines);

      // Check if adding this hunk would exceed the output line limit
      if (totalLines + lines.length > MAX_DIFF_OUTPUT_LINES) {
        const remaining = MAX_DIFF_OUTPUT_LINES - totalLines;
        if (remaining > 0) {
          hunks.push({
            header: buildHunkHeader(
              hunk.oldStart,
              hunk.oldLines,
              hunk.newStart,
              hunk.newLines,
            ),
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            lines: lines.slice(0, remaining),
          });
        }
        truncated = true;
        break;
      }

      hunks.push({
        header: buildHunkHeader(
          hunk.oldStart,
          hunk.oldLines,
          hunk.newStart,
          hunk.newLines,
        ),
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines,
      });
      totalLines += lines.length;
    }

    // ── Count additions / deletions ───────────────────────────────────────
    let additions = 0;
    let deletions = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add") additions++;
        else if (line.type === "delete") deletions++;
      }
    }

    const diffFile: DiffFile = {
      path,
      status: fileStatus,
      additions,
      deletions,
      hunks,
    };

    return {
      version: 1,
      files: [diffFile],
      truncated: truncated || undefined,
    };
  } catch (error) {
    // Diff failure must NEVER fail an already-successful tool
    return {
      version: 1,
      files: [],
      unsupportedReason: "diff_error",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Compute structured diffs for multiple files.
 *
 * Respects `MAX_DIFF_FILES` — extra files are silently skipped with a warning.
 * Merges individual results into a single `ToolDiffMetadata`.
 */
export function computeToolDiffs(
  files: Array<{
    path: string;
    before: string;
    after: string;
    status?: "created" | "modified" | "deleted";
  }>,
): ToolDiffMetadata {
  const limited = files.slice(0, MAX_DIFF_FILES);
  const exceeded = files.length > MAX_DIFF_FILES;

  const results = limited.map((f) => computeToolDiff(f));

  // ── Merge results ──────────────────────────────────────────────────────
  const allFiles: DiffFile[] = [];
  const unsupportedReasons = new Set<ToolDiffUnsupportedReason>();
  const warnings: string[] = [];
  let truncated = false;

  for (const r of results) {
    allFiles.push(...r.files);
    if (r.unsupportedReason) unsupportedReasons.add(r.unsupportedReason);
    if (r.warning) warnings.push(r.warning);
    if (r.truncated) truncated = true;
  }

  const meta: ToolDiffMetadata = { version: 1, files: allFiles };

  if (truncated || exceeded) meta.truncated = true;

  // If every file failed with the same single unsupported reason, propagate it
  if (unsupportedReasons.size === 1 && allFiles.length === 0) {
    meta.unsupportedReason = [...unsupportedReasons][0];
  }

  if (exceeded) {
    warnings.push(
      `Diff computation limited to ${MAX_DIFF_FILES} files; ${files.length - MAX_DIFF_FILES} file(s) skipped.`,
    );
  }

  if (warnings.length > 0) {
    meta.warning = warnings.join("; ");
  }

  return meta;
}

/**
 * Return a human-readable summary for a given unsupported-reason value.
 */
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
