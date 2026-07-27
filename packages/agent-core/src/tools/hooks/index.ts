// ─── Hooks barrel ───
// Re-exports all lifecycle hook factories and helpers.
// Hooks receive finalized output and do not transform tool payloads.

export { createAuditHook } from "./audit";
export type { AuditEvent, AuditHookOptions, AuditSink } from "./audit";
export { createEditErrorRecoveryHook } from "./edit-error-recovery";
export { createExecutionLogger } from "./logger";
export { createPostEditDiagnosticsHook } from "./post-edit-diagnostics";
export {
  createReadSnapshotAfterHook,
  refreshReadSnapshot,
  invalidateReadSnapshot,
} from "./read-snapshot";
