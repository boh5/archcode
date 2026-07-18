import type { BeforeModelBuildContext } from "../loop-hooks";
import type { CircuitBreaker } from "../../../compact/circuit-breaker";
import type { Logger } from "../../../logger";
import type { ToolOutputAccessService } from "../../../tool-output/access-service";
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

export function createAutoCompactHook(
  logger: Logger,
  toolOutputAccess: ToolOutputAccessService,
): AutoCompactHookResult {
  const hybrid = createHybridCompressionHook(logger, toolOutputAccess);
  return { hook: hybrid.beforeModelBuild, circuitBreaker: hybrid.circuitBreaker };
}
