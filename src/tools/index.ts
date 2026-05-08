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
} from "./types.js";

// ─── Values ───
export { DuplicateToolError } from "./types.js";
export { defineTool } from "./define-tool.js";
export { ToolRegistry, ResolvedToolSet, createRegistry } from "./registry.js";
export { createOutputTruncator } from "./hooks/truncate.js";
export type { TruncatorOptions } from "./hooks/truncate.js";
export { createExecutionLogger } from "./hooks/logger.js";
export {
  combineGuardDecisions,
  createPermissionErrorResult,
} from "./hooks/permission.js";
