// ─── Security barrel ───
// Re-exports all low-level security primitives.

export { analyzeBash } from "./bash";
export type {
  AnalyzeBashOptions,
  BashAccess,
  BashAccessOperation,
  BashAnalysis,
  BashInvocation,
  BashSeparator,
} from "./bash";
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
