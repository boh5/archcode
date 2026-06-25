// ─── Types (type-only) ───
export type {
  MaybePromise,
  ToolTraits,
  ToolExecutionResult,
  ToolExecutionContext,
  BeforeHook,
  AfterHook,
  ToolDescriptor,
  ToolCallLike,
  PermissionDecision,
  ToolPermission,
  ToolConfirmationRequest,
  ToolConfirmationCallback,
  ToolConfirmationResult,
  PermissionErrorCode,
  AskUserQuestionOption,
  AskUserQuestion,
  AskUserRequest,
  AskUserAnswer,
  AskUserCallback,
} from "./types";

// ─── Values ───
export { createToolExecutionContext, DuplicateToolError, DestructiveToolPermissionError } from "./types";
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
  createProtectedPathPermission,
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

// ─── Tool Names (single source of truth) ───
export {
  TOOL_FILE_READ,
  TOOL_FILE_WRITE,
  TOOL_FILE_EDIT,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_AST_GREP_SEARCH,
  TOOL_AST_GREP_REPLACE,
  TOOL_GIT_STATUS,
  TOOL_GIT_DIFF,
  TOOL_BASH,
  TOOL_TODO_WRITE,
  TOOL_ASK_USER,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_SYMBOLS,
  TOOL_WEB_FETCH,
  TOOL_DELEGATE,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_SKILL_LIST,
  TOOL_SKILL_READ,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_WRITE,
  TOOL_WORKFLOW_CREATE,
  TOOL_WORKFLOW_READ,
  TOOL_WORKFLOW_UPDATE_STAGE,
  TOOL_WORKFLOW_COMPLETE,
  TOOL_WORKFLOW_RECORD_COMPLETION,
  TOOL_WORKFLOW_TASK_CHECK,
  TOOL_ARTIFACT_READ,
  TOOL_ARTIFACT_WRITE,
} from "./names";

// ─── Tool Groups ───
export {
  EXPLORER_READ_ONLY_TOOLS,
  DELEGATION_TOOLS,
  SKILL_TOOLS,
  DELEGATION_EXECUTION_TOOLS,
} from "./groups";
