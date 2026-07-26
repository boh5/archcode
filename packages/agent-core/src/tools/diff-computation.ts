import { structuredPatch } from "diff";
import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  ToolDiffUnsupportedReason,
} from "@archcode/protocol";

export type DiffStatus = "created" | "modified" | "deleted";

export interface ToolDiffInput {
  path: string;
  before: string;
  after: string;
  status?: DiffStatus;
}

export interface DiffLineBudget {
  remaining: number;
}

export interface DiffComputationLimits {
  maxInputChars: number;
  maxEditLength: number;
}

export interface FileDiffResult {
  file?: DiffFile;
  unsupportedReason?: ToolDiffUnsupportedReason;
  simplified?: true;
  truncated?: boolean;
  warning?: string;
}

/**
 * Detect text that should not enter the line-diff pipeline.
 *
 * NUL bytes are always binary. For the first 1000 characters, a control
 * character ratio above 30% is also considered binary.
 */
export function isProbablyBinaryText(text: string): boolean {
  if (text.includes("\0")) return true;

  const sampleLen = Math.min(text.length, 1_000);
  let nonPrintable = 0;
  for (let i = 0; i < sampleLen; i++) {
    const code = text.charCodeAt(i);
    if ((code > 0 && code < 8) || (code > 13 && code < 32) || code === 11 || code === 12) {
      nonPrintable++;
    }
  }
  return nonPrintable > sampleLen * 0.3;
}

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

function splitContentLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function consumeVisibleLines(lines: DiffLine[], budget: DiffLineBudget): {
  lines: DiffLine[];
  truncated: boolean;
} {
  if (lines.length <= budget.remaining) {
    budget.remaining -= lines.length;
    return { lines, truncated: false };
  }

  const visible = lines.slice(0, budget.remaining);
  budget.remaining = 0;
  return { lines: visible, truncated: true };
}

function consumeReplacementLines(
  beforeLines: string[],
  afterLines: string[],
  budget: DiffLineBudget,
): {
  lines: DiffLine[];
  truncated: boolean;
} {
  const totalLines = beforeLines.length + afterLines.length;
  if (totalLines <= budget.remaining) {
    budget.remaining -= totalLines;
    return {
      lines: [
        ...beforeLines.map((content): DiffLine => ({ type: "delete", content })),
        ...afterLines.map((content): DiffLine => ({ type: "add", content })),
      ],
      truncated: false,
    };
  }

  let beforeCount = Math.min(beforeLines.length, Math.floor(budget.remaining / 2));
  let afterCount = Math.min(afterLines.length, budget.remaining - beforeCount);
  let unallocated = budget.remaining - beforeCount - afterCount;
  const extraBefore = Math.min(beforeLines.length - beforeCount, unallocated);
  beforeCount += extraBefore;
  unallocated -= extraBefore;
  afterCount += Math.min(afterLines.length - afterCount, unallocated);
  budget.remaining = 0;

  return {
    lines: [
      ...beforeLines.slice(0, beforeCount).map(
        (content): DiffLine => ({ type: "delete", content }),
      ),
      ...afterLines.slice(0, afterCount).map(
        (content): DiffLine => ({ type: "add", content }),
      ),
    ],
    truncated: true,
  };
}

function resolveStatus(input: ToolDiffInput): DiffStatus {
  return input.status ?? (input.before === "" ? "created" : "modified");
}

function createFileShell(input: ToolDiffInput, status: DiffStatus): DiffFile {
  return { path: input.path, status, hunks: [] };
}

function createDirectDiff(
  input: ToolDiffInput,
  status: "created" | "deleted",
  budget: DiffLineBudget,
): FileDiffResult {
  const contentLines = splitContentLines(status === "created" ? input.after : input.before);
  const typedLines: DiffLine[] = contentLines.map((content) => ({
    type: status === "created" ? "add" : "delete",
    content,
  }));
  const visible = consumeVisibleLines(typedLines, budget);
  const oldStart = status === "created" ? 0 : 1;
  const oldLines = status === "created" ? 0 : contentLines.length;
  const newStart = status === "created" ? 1 : 0;
  const newLines = status === "created" ? contentLines.length : 0;

  return {
    file: {
      path: input.path,
      status,
      additions: status === "created" ? contentLines.length : 0,
      deletions: status === "deleted" ? contentLines.length : 0,
      hunks:
        visible.lines.length === 0
          ? []
          : [
              {
                header: buildHunkHeader(oldStart, oldLines, newStart, newLines),
                oldStart,
                oldLines,
                newStart,
                newLines,
                lines: visible.lines,
              },
            ],
    },
    truncated: visible.truncated,
  };
}

function parsePatchLine(line: string): DiffLine | undefined {
  if (line.startsWith("\\")) return undefined;
  const content = line.slice(1);
  if (line.startsWith(" ")) return { type: "context", content };
  if (line.startsWith("+")) return { type: "add", content };
  if (line.startsWith("-")) return { type: "delete", content };
  return undefined;
}

function createDetailedModifiedDiff(
  input: ToolDiffInput,
  budget: DiffLineBudget,
  limits: DiffComputationLimits,
): FileDiffResult | undefined {
  const patch = structuredPatch(input.path, input.path, input.before, input.after, "", "", {
    maxEditLength: limits.maxEditLength,
  });
  if (patch === undefined) return undefined;

  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let truncated = false;

  for (const patchHunk of patch.hunks) {
    const parsedLines: DiffLine[] = [];
    for (const rawLine of patchHunk.lines) {
      const line = parsePatchLine(rawLine);
      if (line === undefined) continue;
      if (line.type === "add") additions++;
      if (line.type === "delete") deletions++;
      parsedLines.push(line);
    }

    const visible = consumeVisibleLines(parsedLines, budget);
    truncated ||= visible.truncated;
    if (visible.lines.length === 0) continue;
    hunks.push({
      header: buildHunkHeader(
        patchHunk.oldStart,
        patchHunk.oldLines,
        patchHunk.newStart,
        patchHunk.newLines,
      ),
      oldStart: patchHunk.oldStart,
      oldLines: patchHunk.oldLines,
      newStart: patchHunk.newStart,
      newLines: patchHunk.newLines,
      lines: visible.lines,
    });
  }

  return {
    file: {
      path: input.path,
      status: "modified",
      additions,
      deletions,
      hunks,
    },
    truncated,
  };
}

/**
 * Represent a complex modification as one line-exact replacement hunk.
 *
 * The simplified mode preserves actual before/after lines while making no
 * expensive attempt to align them.
 */
function createSimplifiedModifiedDiff(
  input: ToolDiffInput,
  budget: DiffLineBudget,
): FileDiffResult {
  const beforeLines = splitContentLines(input.before);
  const afterLines = splitContentLines(input.after);
  const visible = consumeReplacementLines(beforeLines, afterLines, budget);

  return {
    file: {
      path: input.path,
      status: "modified",
      additions: afterLines.length,
      deletions: beforeLines.length,
      hunks:
        visible.lines.length === 0
          ? []
          : [
              {
                header: buildHunkHeader(1, beforeLines.length, 1, afterLines.length),
                oldStart: 1,
                oldLines: beforeLines.length,
                newStart: 1,
                newLines: afterLines.length,
                lines: visible.lines,
              },
            ],
    },
    simplified: true,
    truncated: visible.truncated,
  };
}

export function computeBoundedFileDiff(
  input: ToolDiffInput,
  budget: DiffLineBudget,
  limits: DiffComputationLimits,
): FileDiffResult {
  try {
    if (input.before.length + input.after.length > limits.maxInputChars) {
      return { unsupportedReason: "too_large" };
    }
    if (input.before === input.after) return { unsupportedReason: "no_change" };
    if (isProbablyBinaryText(input.before) || isProbablyBinaryText(input.after)) {
      return { unsupportedReason: "binary" };
    }

    const status = resolveStatus(input);
    if (budget.remaining === 0) {
      return {
        file: createFileShell(input, status),
        truncated: true,
      };
    }
    if (status === "created") return createDirectDiff(input, "created", budget);
    if (status === "deleted") return createDirectDiff(input, "deleted", budget);

    const detailed = createDetailedModifiedDiff(input, budget, limits);
    return detailed === undefined
      ? createSimplifiedModifiedDiff(input, budget)
      : detailed;
  } catch (error) {
    return {
      unsupportedReason: "diff_error",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
