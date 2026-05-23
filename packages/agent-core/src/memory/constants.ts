// ---------------------------------------------------------------------------
// Directory / file names
// ---------------------------------------------------------------------------

export const MEMORY_DIR_NAME = "memory";
export const KNOWLEDGE_DIR_NAME = "knowledge";
export const INDEX_FILE = "index.md";
export const PREFERENCES_FILE = "preferences.md";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_INDEX_LINES = 200;
export const CONSOLIDATION_THRESHOLD = 250;
export const DEFAULT_MAX_PREFERENCES_BYTES = 25600; // 25 KB

// ---------------------------------------------------------------------------
// Session-extraction skip conditions
// ---------------------------------------------------------------------------

export const MIN_MESSAGES_FOR_EXTRACTION = 5;
export const MIN_CONTENT_LENGTH_FOR_EXTRACTION = 1000;

/**
 * Minimum interval (ms) between consecutive memory extraction dispatches.
 * Prevents rapid re-extraction after todo-continuation loops.
 */
export const MIN_EXTRACTION_INTERVAL_MS = 300_000; // 5 minutes
export const DEFAULT_EXTRACTION_MAX_MESSAGES = 50;

// ---------------------------------------------------------------------------
// Markers / suffixes
// ---------------------------------------------------------------------------

export const INDEX_TRUNCATION_SUFFIX =
  "\n\n<!-- Memory index truncated. Use memory_read for full details. -->";

export const DEFAULT_MAX_MANIFEST_CHARS = 2000;

export const MANIFEST_PREFERENCES_SNIPPET_LENGTH = 200;

export const MEMORY_CONTEXT_START = "<specra-memory-context>";
export const MEMORY_CONTEXT_END = "</specra-memory-context>";
export const PREFERENCES_MARKER_START = "<specra-memory-preferences>";
export const PREFERENCES_MARKER_END = "</specra-memory-preferences>";
