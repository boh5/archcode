// ─── Hooks barrel ───
// Re-exports all lifecycle hook factories and helpers.
// Security primitives (redactString, redactValue, REDACTION_MARKER) are
// exported from src/tools/security — not from this barrel.

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
export { createRedactionHook } from "./redact";
export { createOutputTruncator } from "./truncate";
export type { TruncatorOptions } from "./truncate";
