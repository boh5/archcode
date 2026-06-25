import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import { atomicWrite } from "../../utils/safe-file";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { computeToolDiff } from "../diff";
import { createToolErrorResult } from "../errors";
import { createEditErrorRecoveryHook, refreshReadSnapshot } from "../hooks";
import { createProtectedPathPermission, createReadBeforeEditPermission, createWorkspacePermission } from "../permission";
import { resolveAndValidatePath } from "../security";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";

// ─── Input Schema ───

const FileEditInputSchema = z
  .object({
    path: z.string().describe("Absolute or workspace-relative path of the file to edit"),
    edits: z.array(
      z
        .object({
          oldString: z.string().min(1, "oldString cannot be empty").describe("Exact text to find in the file. Must be unique within the file — include surrounding context if needed."),
          newString: z.string().describe("Text to replace oldString with"),
        })
        .strict(),
    ).min(1, "edits array must not be empty").describe("Array of text replacements to apply in order. Each entry: { oldString, newString }"),
  })
  .strict();

type FileEditInput = z.infer<typeof FileEditInputSchema>;

interface EditMatch {
  oldString: string;
  newString: string;
  start: number;
  end: number;
}

// ─── Result Type ───

type EditMatchFailureKind =
  | "edit-no-match"
  | "edit-ambiguous"
  | "edit-overlap"
  | "edit-identical";

interface EditMatchSuccess {
  ok: true;
  match: EditMatch;
}

interface EditMatchFailure {
  ok: false;
  kind: EditMatchFailureKind;
  code: string;
  message: string;
}

type EditMatchResult = EditMatchSuccess | EditMatchFailure;

function editMatchOk(match: EditMatch): EditMatchSuccess {
  return { ok: true, match };
}

function editMatchFail(
  kind: EditMatchFailureKind,
  code: string,
  message: string,
): EditMatchFailure {
  return { ok: false, kind, code, message };
}

function editFailToResult(failure: EditMatchFailure): ToolExecutionResult {
  return createToolErrorResult({
    kind: failure.kind,
    code: failure.code,
    message: failure.message,
  });
}

interface NormalizedMapping {
  text: string;
  originalOffsets: number[];
}

// ─── Input Compatibility ───

function prepareEditInput(raw: unknown, _ctx: ToolExecutionContext): unknown {
  if (
    typeof raw === "object" &&
    raw !== null &&
    !("edits" in raw) &&
    "oldString" in raw
  ) {
    const { path: inputPath, oldString, newString } = raw as Record<string, unknown>;
    return { path: inputPath, edits: [{ oldString, newString }] };
  }

  return raw;
}

// ─── Fuzzy Matching ───

function normalizeForFuzzyMatch(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[ \t]+$/gm, "");
}

function normalizeWithMapping(text: string): NormalizedMapping {
  const chars: string[] = [];
  const originalOffsets: number[] = [];

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (char === "\r" && text[index + 1] === "\n") {
      chars.push("\n");
      originalOffsets.push(index);
      index++;
      continue;
    }

    if ((char === " " || char === "\t") && isTrailingWhitespace(text, index)) {
      continue;
    }

    chars.push(normalizeChar(char));
    originalOffsets.push(index);
  }

  return { text: chars.join(""), originalOffsets };
}

function normalizeChar(char: string): string {
  if (char === "\u2018" || char === "\u2019") return "'";
  if (char === "\u201C" || char === "\u201D") return '"';
  if (char === "\u2013" || char === "\u2014") return "-";
  return char;
}

function isTrailingWhitespace(text: string, index: number): boolean {
  for (let cursor = index + 1; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === " " || char === "\t") continue;
    return char === "\n" || char === "\r";
  }

  return true;
}

function findOriginalMatchEnd(
  originalContent: string,
  normalizedOldString: string,
  start: number,
): number | null {
  let normalized = "";
  let index = start;

  while (index < originalContent.length && normalized.length < normalizedOldString.length) {
    const char = originalContent[index];

    if (char === "\r" && originalContent[index + 1] === "\n") {
      normalized += "\n";
      index += 2;
      continue;
    }

    if ((char === " " || char === "\t") && isTrailingWhitespace(originalContent, index)) {
      index++;
      continue;
    }

    normalized += normalizeChar(char);
    index++;
  }

  if (normalized !== normalizedOldString) {
    return null;
  }

  return index;
}

function findExactMatch(content: string, oldString: string): EditMatchResult {
  const start = content.indexOf(oldString);
  if (start === -1) {
    return editMatchFail(
      "edit-no-match",
      "TOOL_EDIT_NO_MATCH",
      `oldString not found in file: "${oldString.substring(0, 80)}..."`,
    );
  }

  const secondMatch = content.indexOf(oldString, start + 1);
  if (secondMatch !== -1) {
    return editMatchFail(
      "edit-ambiguous",
      "TOOL_EDIT_AMBIGUOUS_MATCH",
      `oldString matched multiple locations. Provide more surrounding context to make the match unique: "${oldString.substring(0, 80)}..."`,
    );
  }

  return editMatchOk({ oldString, newString: "", start, end: start + oldString.length });
}

function findFuzzyMatch(content: string, oldString: string): EditMatchResult {
  const normalized = normalizeWithMapping(content);
  const normalizedOldString = normalizeForFuzzyMatch(oldString);
  const startInNormalized = normalized.text.indexOf(normalizedOldString);

  if (startInNormalized === -1) {
    return editMatchFail(
      "edit-no-match",
      "TOOL_EDIT_NO_MATCH",
      `oldString not found in file: "${oldString.substring(0, 80)}..." Re-read the file to get the current content before editing.`,
    );
  }

  const secondMatch = normalized.text.indexOf(normalizedOldString, startInNormalized + 1);
  if (secondMatch !== -1) {
    return editMatchFail(
      "edit-ambiguous",
      "TOOL_EDIT_AMBIGUOUS_MATCH",
      `oldString matched multiple locations. Provide more surrounding context to make the match unique: "${oldString.substring(0, 80)}..."`,
    );
  }

  const start = normalized.originalOffsets[startInNormalized];
  if (start === undefined) {
    return editMatchFail(
      "edit-no-match",
      "TOOL_EDIT_NO_MATCH",
      `oldString not found in file: "${oldString.substring(0, 80)}..." Re-read the file to get the current content before editing.`,
    );
  }

  const end = findOriginalMatchEnd(content, normalizedOldString, start);
  if (end === null) {
    return editMatchFail(
      "edit-no-match",
      "TOOL_EDIT_NO_MATCH",
      "Unable to map fuzzy match back to original content. [TOOL_EDIT_NO_MATCH]",
    );
  }

  return editMatchOk({ oldString, newString: "", start, end });
}

function findEditMatches(
  content: string,
  edits: FileEditInput["edits"],
): EditMatch[] | EditMatchFailure {
  const matches: EditMatch[] = [];

  for (const edit of edits) {
    if (edit.oldString === edit.newString) {
      return editMatchFail(
        "edit-identical",
        "TOOL_EDIT_IDENTICAL",
        `oldString and newString are identical for edit in "${edit.oldString.substring(0, 50)}..."`,
      );
    }

    const exactResult = findExactMatch(content, edit.oldString);
    let result: EditMatchResult;
    if (!exactResult.ok && exactResult.kind === "edit-no-match") {
      result = findFuzzyMatch(content, edit.oldString);
    } else {
      result = exactResult;
    }

    if (!result.ok) return result;

    matches.push({ ...result.match, newString: edit.newString });
  }

  const sorted = [...matches].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].start < sorted[index - 1].end) {
      return editMatchFail(
        "edit-overlap",
        "TOOL_EDIT_OVERLAP",
        "Overlapping edits detected. Ensure each oldString targets a non-overlapping section.",
      );
    }
  }

  return matches;
}

// ─── Edit Application ───

function applyEdits(content: string, matches: EditMatch[]): string {
  const sorted = [...matches].sort((a, b) => b.start - a.start);

  let result = content;
  for (const match of sorted) {
    result = result.substring(0, match.start) + match.newString + result.substring(match.end);
  }

  return result;
}

// ─── Tool Definition ───

export const fileEditTool = defineTool({
  name: "file_edit",
  description:
    "Applies targeted text replacements to an existing file. The file must be read first with file_read. Each edit replaces oldString with newString.",
  inputSchema: FileEditInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  prepareInput: prepareEditInput,
  permissions: [createWorkspacePermission(), createReadBeforeEditPermission(), createProtectedPathPermission()],
  hooks: { after: [createEditErrorRecoveryHook()] },
  execute: async (input, ctx): Promise<string | ToolExecutionResult> => {
    // Workspace access is enforced by createWorkspacePermission() guard.
    // If the permission pipeline allows execution, out-of-workspace paths
    // may have been explicitly approved and should not be re-checked here.
    const { resolved: resolvedPath } = resolveAndValidatePath(input.path, ctx.workspaceRoot);

    try {
      const result = await sharedMutationQueue.enqueue(resolvedPath, async () => {
        if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "TOOL_FILE_NOT_FOUND",
            message: `File not found: ${input.path}`,
          });
        }

        const content = await Bun.file(resolvedPath).text();
        const matchResult = findEditMatches(content, input.edits);
        if (!Array.isArray(matchResult)) {
          return editFailToResult(matchResult);
        }
        const matches = matchResult;

        const modified = applyEdits(content, matches);

        try {
          await atomicWrite(resolvedPath, modified);
        } catch (error) {
          return createToolErrorResult({
            kind: "execution",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }

        refreshReadSnapshot(resolvedPath, ctx.store, ctx.workspaceRoot);
        return {
          output: `Successfully applied ${matches.length} edit(s) to ${input.path}`,
          isError: false,
          meta: {
            diffs: computeToolDiff({
              path: input.path,
              before: content,
              after: modified,
              status: "modified",
            }),
          },
        };
      });

      return result;
    } catch (error) {
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});

export const __testing = {
  applyEdits,
  editFailToResult,
  editMatchFail,
  editMatchOk,
  findExactMatch,
  findEditMatches,
  findFuzzyMatch,
  findOriginalMatchEnd,
  normalizeForFuzzyMatch,
  prepareEditInput,
};
