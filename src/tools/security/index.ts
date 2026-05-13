// ─── Security barrel ───
// Re-exports all low-level security primitives.

export { classifyCommand } from "./bash-classifier";
export {
  PathValidator,
  createPathValidator,
  validateWorkspacePath,
  resolveAndValidatePath,
} from "./path-validator";
export type {
  PathValidationError,
  PathValidationErrorCode,
  PathValidationResult,
  ResolveAndValidatePathResult,
} from "./path-validator";
export { redactString, redactValue, REDACTION_MARKER } from "./redaction";
