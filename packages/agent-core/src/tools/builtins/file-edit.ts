import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import { atomicWrite } from "../../utils/safe-file";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { computeToolDiff } from "../diff";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import { createEditErrorRecoveryHook, createPostEditDiagnosticsHook, refreshReadSnapshot } from "../hooks";
import { createProtectedPathPermission, createReadBeforeEditPermission, createWorkspacePermission } from "../permission";
import { resolveAndValidatePath } from "../security";
import type { RawToolResult, ToolExecutionContext } from "../types";

// ─── Input Schema ───

const FileEditInputSchema = z
  .object({
    path: z.string().describe("Absolute or current-Session-cwd-relative path of an existing file to modify, for example `src/config.ts`. The target path must already exist; use file_write only for a genuinely new file."),
    edits: z.array(
      z
        .object({
          oldString: z.string().min(1, "oldString cannot be empty").describe("Exact existing text to replace, copied without file_read line-number prefixes. Preserve leading indentation. It must resolve to exactly one location; re-read after no match or add surrounding context after multiple matches."),
          newString: z.string().describe("Complete replacement text, including the intended indentation and line breaks. Must differ from oldString."),
        })
        .strict(),
    ).min(1, "edits array must not be empty").describe("Non-empty array of non-overlapping replacements. Every oldString is matched against the same pre-edit file; the complete group is validated before one atomic write."),
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

function editFailToResult(failure: EditMatchFailure): RawToolResult {
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

function prepareEditInput(raw: unknown, _ctx: ToolExecutionContext): unknown {
  return normalizeEditInput(raw);
}

function normalizeEditInput(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("edits" in raw)) return raw;

  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.edits)) return raw;

  return {
    ...input,
    edits: input.edits.map((edit) => {
      if (typeof edit !== "object" || edit === null || !("oldString" in edit)) return edit;
      const entry = edit as Record<string, unknown>;
      if (typeof entry.oldString !== "string") return edit;
      return { ...entry, oldString: normalizeEditSearchText(entry.oldString) };
    }),
  };
}

// ─── Fuzzy Matching ───

function normalizeForFuzzyMatch(text: string): string {
  return normalizeEditSearchText(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "");
}

function normalizeEditSearchText(text: string): string {
  return text.normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-");
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

    const normalizedChar = normalizeChar(char);
    for (let offset = 0; offset < normalizedChar.length; offset++) {
      chars.push(normalizedChar[offset]);
      originalOffsets.push(index);
    }
  }

  return { text: chars.join(""), originalOffsets };
}

function normalizeChar(char: string): string {
  return normalizeEditSearchText(char);
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
  description: [
    "MODIFY EXISTING FILE ONLY. Use file_edit for EVERY modification to an existing file, including when most or all of its content must change. Never use file_write to replace, rewrite, or update an existing file; file_write is only for a genuinely new path.",
    "",
    "Apply one or more targeted replacements to the existing file.",
    "",
    "Required workflow:",
    "1. Read the file first. Copy oldString from the file content without the `N: ` line-number prefix and preserve exact indentation.",
    "2. Call with one or more non-overlapping edits. Example: `file_edit({\"path\":\"src/config.ts\",\"edits\":[{\"oldString\":\"  const mode = \\\"dev\\\";\",\"newString\":\"  const mode = \\\"prod\\\";\"}]})`.",
    "3. If no match is found, re-read because the file may have changed. If multiple matches are found, add surrounding context until oldString is unique. Do not guess or retry the same stale text.",
    "4. After success, inspect the change and use lsp_diagnostics plus the relevant test/build command when appropriate; use git_diff as an additional review surface in a Git workspace.",
    "",
    "All edits are matched against the same pre-edit file, the entire group is validated before writing, and the non-overlapping replacements are committed in one atomic write.",
  ].join("\n"),
  inputSchema: FileEditInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  prepareInput: prepareEditInput,
  permissions: [createWorkspacePermission(), createReadBeforeEditPermission(), createProtectedPathPermission()],
  hooks: { after: [createEditErrorRecoveryHook(), createPostEditDiagnosticsHook()] },
  execute: async (input, ctx): Promise<RawToolResult> => {
    // Workspace access is enforced by createWorkspacePermission() guard.
    // If the permission pipeline allows execution, out-of-workspace paths
    // may have been explicitly approved and should not be re-checked here.
    const { resolved: resolvedPath } = resolveAndValidatePath(input.path, ctx.cwd);

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

        refreshReadSnapshot(resolvedPath, ctx.store, ctx.cwd);
        const diff = computeToolDiff({
          path: input.path,
          before: content,
          after: modified,
          status: "modified",
        });
        return createTextToolResult(`Successfully applied ${matches.length} edit(s) to ${input.path}`, {
          details: diff.files.length === 0
            ? undefined
            : { presentations: [{ kind: "diff", files: diff.files, ...(diff.truncated ? { truncated: true } : {}) }] },
        });
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
  normalizeEditSearchText,
  prepareEditInput,
};
