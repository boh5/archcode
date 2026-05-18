import { MemoryFileManager, parseIndex } from "./file-manager";
import { DEFAULT_MAX_MANIFEST_CHARS, MANIFEST_PREFERENCES_SNIPPET_LENGTH } from "./constants";

function snippet(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

function truncateManifest(manifest: string, maxChars: number): string {
  if (manifest.length <= maxChars) return manifest;
  return manifest.slice(0, maxChars) + "\n\n<!-- manifest truncated -->";
}

/**
 * Build a memory manifest from existing memories for injection into
 * the extraction prompt. Uses the index (not full topic files) to
 * keep token cost low while providing enough context for dedup.
 *
 * Format uses explicit "name" field so the LLM can directly match
 * against existing topics without ambiguity.
 */
export async function buildMemoryManifest(
  fileManager: MemoryFileManager,
): Promise<string> {
  const parts: string[] = [];

  const prefs = await fileManager.readPreferences();
  if (prefs !== null && prefs.trim().length > 0) {
    parts.push(`[user preferences]\n${snippet(prefs, MANIFEST_PREFERENCES_SNIPPET_LENGTH)}`);
  }

  const indexContent = await fileManager.readIndex();
  if (indexContent !== null) {
    const entries = parseIndex(indexContent);
    if (entries.length > 0) {
      const topicLines = entries.map(
        (e) => `- name: "${e.name}", title: "${e.title}", summary: "${e.summary}"`,
      );
      parts.push("[existing knowledge topics]\n" + topicLines.join("\n"));
    }
  }

  const manifest = parts.join("\n\n");
  return truncateManifest(manifest, DEFAULT_MAX_MANIFEST_CHARS);
}