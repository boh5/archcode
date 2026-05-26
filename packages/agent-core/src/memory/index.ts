// ─── Types ───
export type { MemoryTopicType, MemoryIndexEntry, MemoryTopicFile, MemoryPreferences, MemoryRoots } from "./types";

// ─── Schemas ───
export { MEMORY_TOPIC_VALUES, MemoryTopicTypeSchema, MemoryFrontmatterSchema } from "./schemas";

// ─── Constants ───
export {
  CONSOLIDATION_THRESHOLD,
  DEFAULT_EXTRACTION_MAX_MESSAGES,
  DEFAULT_MAX_INDEX_LINES,
  DEFAULT_MAX_MANIFEST_CHARS,
  DEFAULT_MAX_PREFERENCES_BYTES,
  INDEX_FILE,
  INDEX_TRUNCATION_SUFFIX,
  KNOWLEDGE_DIR_NAME,
  MANIFEST_PREFERENCES_SNIPPET_LENGTH,
  MEMORY_CONTEXT_END,
  MEMORY_CONTEXT_START,
  MEMORY_DIR_NAME,
  MIN_CONTENT_LENGTH_FOR_EXTRACTION,
  MIN_EXTRACTION_INTERVAL_MS,
  MIN_MESSAGES_FOR_EXTRACTION,
  PREFERENCES_FILE,
  PREFERENCES_MARKER_END,
  PREFERENCES_MARKER_START,
} from "./constants";

// ─── File Manager ───
export {
  MemoryFileManager,
  MemoryPathError,
  formatFrontmatter,
  formatIndex,
  formatSimpleYaml,
  parseFrontmatter,
  parseIndex,
  parseSimpleYaml,
} from "./file-manager";

// ─── Manifest ───
export { buildMemoryManifest } from "./manifest";
