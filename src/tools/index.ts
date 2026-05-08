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
  GuardDecision,
  GuardHook,
  ToolConfirmationRequest,
  ToolConfirmationCallback,
  PermissionErrorCode,
} from "./types";

// ─── Values ───
export { DuplicateToolError } from "./types";
export { defineTool } from "./define-tool";
export { ToolRegistry, ResolvedToolSet, createRegistry } from "./registry";
export { createOutputTruncator } from "./hooks/truncate";
export type { TruncatorOptions } from "./hooks/truncate";
export { createExecutionLogger } from "./hooks/logger";
export {
  combineGuardDecisions,
  createPermissionErrorResult,
} from "./hooks/permission";
export {
  createReadSnapshotAfterHook,
  createReadBeforeEditGuard,
  createWorkspaceGuard as createWorkspaceGuardFromSnapshot,
  createSensitiveFileGuard as createSensitiveFileGuardFromSnapshot,
  isSensitiveFile,
  resolveAndValidatePath,
  refreshReadSnapshot,
  invalidateReadSnapshot,
  SENSITIVE_PATTERNS,
} from "./hooks/read-snapshot";
export type { AfterHook as AfterHookType } from "./types";
export { createEditErrorRecoveryHook } from "./hooks/edit-error-recovery";
export { createWorkspaceGuard } from "./hooks/workspace-guard";

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
  createBuiltinToolDescriptors,
} from "./builtins";
