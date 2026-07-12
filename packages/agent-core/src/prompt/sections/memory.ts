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

function buildMemoryToolsDescription(ctx: PromptContext): string {
  const canRead = ctx.allowedTools.includes("memory_read");
  const canWrite = ctx.allowedTools.includes("memory_write");
  const lines = ["Memory context is automatically injected when available."];

  if (canRead) {
    lines.push('- memory_read: Read combined context, preferences, the project index, or a named knowledge topic.');
  }
  if (canWrite) {
    lines.push('- memory_write: Save durable user preferences or project knowledge. Never save secrets, API keys, or passwords.');
    lines.push('When durable learning is worth preserving, use name="preferences" with scope="user" for user preferences and another topic name for project knowledge.');
  }

  return lines.join("\n");
}

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

  const [index, userPrefs] = await Promise.all([
    ctx.memoryRoots === undefined ? Promise.resolve(null) : new MemoryFileManager(ctx.memoryRoots).readIndex(),
    ctx.memoryRoots === undefined ? Promise.resolve(null) : new MemoryFileManager(ctx.memoryRoots).readPreferences(),
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

  return `## Memory\n\n${parts.join("\n\n")}\n\n${buildMemoryToolsDescription(ctx)}`;
}
