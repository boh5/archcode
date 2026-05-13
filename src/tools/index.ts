// ─── Types (type-only) ───
export type {
  MaybePromise,
  ToolTraits,
  ToolExecutionResult,
  ToolExecutionContext,
  Logger,
  BeforeHook,
  AfterHook,
  ToolDescriptor,
  ToolCallLike,
  PermissionDecision,
  ToolPermission,
  ToolConfirmationRequest,
  ToolConfirmationCallback,
  PermissionErrorCode,
  AskUserQuestionOption,
  AskUserQuestion,
  AskUserRequest,
  AskUserAnswer,
  AskUserCallback,
} from "./types";

// ─── Values ───
export { DuplicateToolError, DestructiveToolPermissionError } from "./types";
export { defineTool } from "./define-tool";
export { ToolRegistry, ResolvedToolSet, createRegistry } from "./registry";
export { createOutputTruncator, type TruncatorOptions } from "./hooks";
export {
  persistToolOutput,
  persistToolOutputValue,
  TOOL_OUTPUT_DIR,
} from "./persist-output";
export type { PersistOptions, PersistableToolPart } from "./persist-output";
export { createExecutionLogger } from "./hooks";
export { redactString, redactValue, REDACTION_MARKER } from "./security";
export { createRedactionHook, createAuditHook } from "./hooks";
export type { AuditEvent, AuditHookOptions, AuditSink } from "./hooks";
export {
  combinePermissionDecisions,
  createPermissionErrorResult,
  createWorkspacePermission,
  createSensitiveFilePermission,
  isSensitiveFile,
  SENSITIVE_PATTERNS,
  createMemoryIndexPermission,
  createReadBeforeEditPermission,
  createFileExistsPermission,
  createBashPermission,
  createMcpDestructivePermission,
} from "./permission";
export type { WorkspacePermissionOptions } from "./permission";
export {
  TOOL_ERROR_META_KEY,
  createToolErrorResult,
  extractCode,
  formatToolError,
  inferToolErrorKindFromResult,
  isStructuredToolError,
  normalizeToolErrorResult,
  serializeToolError,
} from "./errors";
export type { FormattedToolError, FormatToolErrorOptions, ToolErrorKind } from "./errors";
export {
  createReadSnapshotAfterHook,
  refreshReadSnapshot,
  invalidateReadSnapshot,
} from "./hooks";
export type { AfterHook as AfterHookType } from "./types";
export { createEditErrorRecoveryHook } from "./hooks";
export {
  PathValidator,
  createPathValidator,
  validateWorkspacePath,
} from "./security";
export type {
  PathValidationError,
  PathValidationErrorCode,
  PathValidationResult,
  ResolveAndValidatePathResult,
} from "./security";

// ─── Tool Output Cache (LRU Cleanup) ───
export {
  DEFAULT_QUOTA_MB,
  enforceQuota,
  getCacheStats,
} from "./tool-output-cache";
export type { CacheStats } from "./tool-output-cache";

// ─── Concurrency ───
export { createMutationQueue, sharedMutationQueue } from "./concurrency/mutation-queue";
export type { MutationQueue } from "./concurrency/mutation-queue";
export { partitionToolCalls } from "./concurrency/partition";
export type { ToolCallBatch } from "./concurrency/partition";

// ─── Ripgrep ───
export { createRipgrepService, RipgrepNotFoundError } from "./ripgrep/service";
export type { RipgrepService, DiscoverySeam } from "./ripgrep/service";
export {
  parseRgJsonLine,
  parseRgOutput,
  formatSearchResult,
  buildSearchArgs,
} from "./ripgrep/search";
export type {
  SearchArgs,
  FileArgs,
  MatchLine,
  MatchResult,
  SearchResult,
} from "./ripgrep/search";

// ─── Builtins ───
export {
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  gitStatusTool,
  gitDiffTool,
  bashTool,
  todoWriteTool,
  askUserTool,
  lspDiagnosticsTool,
  lspGotoDefinitionTool,
  lspFindReferencesTool,
  lspSymbolsTool,
  createBuiltinToolDescriptors,
} from "./builtins";
