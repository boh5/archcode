import type { PromptContext } from "../types";
import { MemoryFileManager } from "../../memory/file-manager";
import {
  DEFAULT_MAX_INDEX_LINES,
  DEFAULT_MAX_PREFERENCES_BYTES,
  INDEX_TRUNCATION_SUFFIX,
  MEMORY_CONTEXT_END,
  MEMORY_CONTEXT_START,
  PREFERENCES_MARKER_END,
  PREFERENCES_MARKER_START,
} from "../../memory/constants";

const MEMORY_TOOLS_DESCRIPTION = `You have access to project and user memory via these tools:
- memory_read: Read memory (no name = combined context with user preferences + project index; name "preferences" = user preferences; name "index" = project index; otherwise name = knowledge topic)
- memory_write: Write memory (name "preferences" with scope="user" to save user preferences; any other name to write a project knowledge topic; index is auto-managed)

Memory is automatically injected into your context. When you learn something durable about the user's preferences or working style, use memory_write with name="preferences". For project knowledge and conventions, use any other topic name. Do not save secrets, API keys, or passwords.`;

function truncateIndex(content: string, maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join("\n") + INDEX_TRUNCATION_SUFFIX;
}

function truncateByBytes(content: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  if (bytes.length <= maxBytes) return content;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(bytes.slice(0, maxBytes)) + "\n\n<!-- preferences truncated -->";
}

export async function buildMemorySection(ctx: PromptContext): Promise<string | null> {
  if (ctx.memoryRoots === undefined) {
    return null;
  }

  const fm = new MemoryFileManager(ctx.memoryRoots);

  const [index, userPrefs] = await Promise.all([
    fm.readIndex(),
    fm.readPreferences(),
  ]);

  const parts: string[] = [];

  if (userPrefs !== null) {
    const truncated = truncateByBytes(userPrefs, DEFAULT_MAX_PREFERENCES_BYTES);
    parts.push(
      `${PREFERENCES_MARKER_START}\n${truncated}\n${PREFERENCES_MARKER_END}`,
    );
  }

  if (index !== null) {
    const truncated = truncateIndex(index, DEFAULT_MAX_INDEX_LINES);
    parts.push(
      `${MEMORY_CONTEXT_START}\n${truncated}\n${MEMORY_CONTEXT_END}`,
    );
  }

  if (parts.length === 0) return null;

  return `## Memory\n\n${parts.join("\n\n")}\n\n${MEMORY_TOOLS_DESCRIPTION}`;
}