// ─── Types (type-only) ───
export type {
  MaybePromise,
  ToolCapabilities,
  ToolExecutionResult,
  ToolExecutionContext,
  Logger,
  BeforeHook,
  AfterHook,
  ToolDescriptor,
  ToolCallLike,
} from "./types.js";

// ─── Values ───
export { DuplicateToolError } from "./types.js";
export { defineTool } from "./define-tool.js";
export { ToolRegistry, ResolvedToolSet, createRegistry } from "./registry.js";
export { createOutputTruncator } from "./hooks/truncate.js";
export type { TruncatorOptions } from "./hooks/truncate.js";
export { createExecutionLogger } from "./hooks/logger.js";
export { createPermissionGuard } from "./hooks/permission.js";
