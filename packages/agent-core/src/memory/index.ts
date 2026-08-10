// ─── Types ───
export type { MemoryTopicType, MemoryIndexEntry, MemoryTopicFile, MemoryPreferences, MemoryRoots } from "./types";

// ─── Schemas ───
export { MEMORY_TOPIC_VALUES, MemoryTopicTypeSchema, MemoryFrontmatterSchema } from "./schemas";

// ─── Constants ───
export {
  DEFAULT_MAX_PREFERENCES_BYTES,
  MAX_MEMORY_TOPIC_BYTES,
  MAX_MEMORY_TOPICS,
  INDEX_FILE,
  KNOWLEDGE_DIR_NAME,
  MEMORY_CONTEXT_END,
  MEMORY_CONTEXT_START,
  MEMORY_DIR_NAME,
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

// ─── Domain Service ───
export { MemoryService, memoryRevision } from "./service";
export type {
  MemoryApplyResult,
  MemoryDocumentSnapshot,
  MemoryDocumentTarget,
  MemoryExplicitWriteInput,
  MemoryFinalDocumentTarget,
  MemoryFinalIndexDocument,
  MemoryIndexProjection,
  MemoryChangeListener,
  MemoryPromptManifest,
  PutMemoryPreferencesInput,
  PutMemoryTopicInput,
} from "./service";
export {
  MemoryCapacityError,
  MemoryDomainError,
  MemoryRevisionConflictError,
  MemorySecretError,
  MemoryValidationError,
} from "./errors";
export type { MemoryDomainErrorCode } from "./errors";

// ─── Runtime Policy ───
export {
  DEFAULT_MEMORY_POLICY,
  MemoryPolicyRuntime,
} from "./policy-runtime";
export type {
  MemoryApplyAdmission,
  MemoryPolicy,
  MemoryPolicyEpoch,
  MemoryPolicySnapshot,
} from "./policy-runtime";
