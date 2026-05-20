export {
  TOKEN_CHARS_RATIO,
  COMPACT_THRESHOLD,
  COMPACT_MIN_NEW_MESSAGES,
  estimateContextTokens,
  parseStepUsage,
  shouldAutoCompact,
} from "./token-estimation";

export {
  CompactError,
  compact,
  commitCompact,
  __setStreamTextForTest,
} from "./compact";

export type { CompactInput, CompactResult } from "./compact";

export type { CircuitBreaker } from "./circuit-breaker";
export { createCircuitBreaker } from "./circuit-breaker";