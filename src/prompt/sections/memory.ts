import type { PromptContext } from "../types";
import { MemoryFileManager } from "../../memory/file-manager";
import {
  COMBINED_PREFERENCES_MAX_BYTES,
  DEFAULT_MAX_INDEX_LINES,
  DEFAULT_MAX_PREFERENCES_BYTES,
  INDEX_TRUNCATION_SUFFIX,
  MEMORY_CONTEXT_END,
  MEMORY_CONTEXT_START,
  PREFERENCES_MARKER_END,
  PREFERENCES_MARKER_START,
  PROJECT_PREFERENCES_MARKER_END,
  PROJECT_PREFERENCES_MARKER_START,
} from "../../memory/constants";

const MEMORY_TOOLS_DESCRIPTION = `You have access to project and user memory via these tools:
- memory_read: Read memory (no name = combined context; name "preferences" = project prefs; name "index" = memory index; otherwise name = knowledge topic)
- memory_write: Write or update a knowledge topic (name must be letters, numbers, underscores only; index is auto-managed)

Memory is automatically injected into your context. When you learn something durable about the user's preferences or project conventions, use memory_write to save it. Do not save secrets, API keys, or passwords.`;

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

  const [index, userPrefs, projectPrefs] = await Promise.all([
    fm.readIndex(),
    fm.readPreferences("user"),
    fm.readPreferences("project"),
  ]);

  const parts: string[] = [];
  let truncatedUserPrefs: string | null = null;

  if (userPrefs !== null) {
    truncatedUserPrefs = truncateByBytes(userPrefs, DEFAULT_MAX_PREFERENCES_BYTES);
    parts.push(
      `${PREFERENCES_MARKER_START}\n${truncatedUserPrefs}\n${PREFERENCES_MARKER_END}`,
    );
  }

  let projectPrefsContent: string | null = null;
  if (projectPrefs !== null) {
    projectPrefsContent = truncateByBytes(projectPrefs, DEFAULT_MAX_PREFERENCES_BYTES);

    if (truncatedUserPrefs !== null) {
      const encoder = new TextEncoder();
      const userBytes = encoder.encode(truncatedUserPrefs).length;
      const remaining = COMBINED_PREFERENCES_MAX_BYTES - userBytes;
      if (remaining > 0) {
        projectPrefsContent = truncateByBytes(projectPrefsContent, remaining);
      } else {
        projectPrefsContent = null;
      }
    }
  }

  if (projectPrefsContent !== null) {
    parts.push(
      `${PROJECT_PREFERENCES_MARKER_START}\n${projectPrefsContent}\n${PROJECT_PREFERENCES_MARKER_END}`,
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
