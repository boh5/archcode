import type { BeforeModelBuildContext } from "../loop-hooks";
import type { CircuitBreaker } from "../../../compact/circuit-breaker";
import type { Logger } from "../../../logger";
import { createHybridCompressionHook } from "./hybrid-compression";

// ---------------------------------------------------------------------------
// Auto-compact hook result
// ---------------------------------------------------------------------------

export interface AutoCompactHookResult {
  hook: (ctx: BeforeModelBuildContext) => Promise<void>;
  circuitBreaker: CircuitBreaker;
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

export function createAutoCompactHook(logger: Logger): AutoCompactHookResult {
  const hybrid = createHybridCompressionHook(logger);
  return { hook: hybrid.beforeModelBuild, circuitBreaker: hybrid.circuitBreaker };
}
