import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sharedMutationQueue } from "../concurrency/mutation-queue";
import { defineTool } from "../define-tool";
import { createEditErrorRecoveryHook } from "../hooks/edit-error-recovery";
import {
  createReadBeforeEditGuard,
  createWorkspaceGuard,
  refreshReadSnapshot,
  resolveAndValidatePath,
} from "../hooks/read-snapshot";
import type { ToolExecutionContext } from "../types";

// ─── Input Schema ───

const FileEditInputSchema = z
  .object({
    path: z.string(),
    edits: z.array(
      z
        .object({
          oldString: z.string().min(1, "oldString cannot be empty"),
          newString: z.string(),
        })
        .strict(),
    ).min(1, "edits array must not be empty"),
  })
  .strict();

type FileEditInput = z.infer<typeof FileEditInputSchema>;

interface EditMatch {
  oldString: string;
  newString: string;
  start: number;
  end: number;
}

interface NormalizedMapping {
  text: string;
  originalOffsets: number[];
}

class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
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
): number {
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
    throw new EditError(
      `Unable to map fuzzy match back to original content. [TOOL_EDIT_NO_MATCH]`,
    );
  }

  return index;
}

function findExactMatch(content: string, oldString: string): EditMatch | string {
  const start = content.indexOf(oldString);
  if (start === -1) return "not-found";

  const secondMatch = content.indexOf(oldString, start + 1);
  if (secondMatch !== -1) {
    return `oldString matched multiple locations. Provide more surrounding context to make the match unique: "${oldString.substring(0, 80)}...". [TOOL_EDIT_AMBIGUOUS_MATCH]`;
  }

  return { oldString, newString: "", start, end: start + oldString.length };
}

function findFuzzyMatch(content: string, oldString: string): EditMatch | string {
  const normalized = normalizeWithMapping(content);
  const normalizedOldString = normalizeForFuzzyMatch(oldString);
  const startInNormalized = normalized.text.indexOf(normalizedOldString);

  if (startInNormalized === -1) {
    return `oldString not found in file: "${oldString.substring(0, 80)}..." [TOOL_EDIT_NO_MATCH]. Re-read the file to get the current content before editing.`;
  }

  const secondMatch = normalized.text.indexOf(normalizedOldString, startInNormalized + 1);
  if (secondMatch !== -1) {
    return `oldString matched multiple locations. Provide more surrounding context to make the match unique: "${oldString.substring(0, 80)}...". [TOOL_EDIT_AMBIGUOUS_MATCH]`;
  }

  const start = normalized.originalOffsets[startInNormalized];
  if (start === undefined) {
    return `oldString not found in file: "${oldString.substring(0, 80)}..." [TOOL_EDIT_NO_MATCH]. Re-read the file to get the current content before editing.`;
  }

  return {
    oldString,
    newString: "",
    start,
    end: findOriginalMatchEnd(content, normalizedOldString, start),
  };
}

function findEditMatches(content: string, edits: FileEditInput["edits"]): EditMatch[] {
  const matches: EditMatch[] = [];

  for (const edit of edits) {
    if (edit.oldString === edit.newString) {
      throw new EditError(
        `oldString and newString are identical for edit in "${edit.oldString.substring(0, 50)}..." [TOOL_EDIT_IDENTICAL]`,
      );
    }

    let match = findExactMatch(content, edit.oldString);
    if (match === "not-found") {
      match = findFuzzyMatch(content, edit.oldString);
    }

    if (typeof match === "string") {
      throw new EditError(match);
    }

    matches.push({ ...match, newString: edit.newString });
  }

  const sorted = [...matches].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].start < sorted[index - 1].end) {
      throw new EditError(
        "Overlapping edits detected. Ensure each oldString targets a non-overlapping section. [TOOL_EDIT_OVERLAP]",
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

async function cleanupTempFile(tmpPath: string): Promise<void> {
  try {
    await unlink(tmpPath);
  } catch {
    // Best-effort cleanup only.
  }
}

function toEditError(error: unknown, filePath: string): EditError {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return new EditError(`File not found: ${filePath} [TOOL_EDIT_NO_MATCH]`);
    }
    if (code === "EACCES" || code === "EPERM") {
      return new EditError(`Permission denied: ${filePath}`);
    }
  }

  if (error instanceof EditError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new EditError(`Failed to edit file ${filePath}: ${message}`);
}

// ─── Tool Definition ───

export const fileEditTool = defineTool({
  name: "file_edit",
  description:
    "Applies targeted text replacements to an existing file. The file must be read first with file_read. Each edit replaces oldString with newString.",
  inputSchema: FileEditInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  prepareInput: prepareEditInput,
  guards: [createWorkspaceGuard(), createReadBeforeEditGuard()],
  hooks: { after: [createEditErrorRecoveryHook()] },
  execute: async (input, ctx) => {
    const { resolved: resolvedPath, isWithinWorkspace } = resolveAndValidatePath(input.path, ctx.workspaceRoot);
    if (!isWithinWorkspace) {
      throw new EditError(`"${resolvedPath}" is outside workspace "${ctx.workspaceRoot}" [TOOL_FILE_OUTSIDE_WORKSPACE]`);
    }

    try {
      return await sharedMutationQueue.enqueue(resolvedPath, async () => {
        if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
          throw new EditError(`File not found: ${input.path} [TOOL_EDIT_NO_MATCH]`);
        }

        const content = await readFile(resolvedPath, "utf8");
        const matches = findEditMatches(content, input.edits);
        const modified = applyEdits(content, matches);
        const tmpPath = `${resolvedPath}.tmp.${randomUUID()}`;

        await writeFile(tmpPath, modified);

        try {
          await rename(tmpPath, resolvedPath);
        } catch (error) {
          await cleanupTempFile(tmpPath);
          throw error;
        }

        refreshReadSnapshot(resolvedPath, ctx.store, ctx.workspaceRoot);
        return `Successfully applied ${matches.length} edit(s) to ${input.path}`;
      });
    } catch (error) {
      throw toEditError(error, input.path);
    }
  },
});

export const __testing = {
  applyEdits,
  findEditMatches,
  normalizeForFuzzyMatch,
  prepareEditInput,
};
