import type { BeforeModelBuildContext } from "../loop-hooks";
import type { CircuitBreaker } from "../../../compact/circuit-breaker";
import { createCircuitBreaker } from "../../../compact/circuit-breaker";
import { compact, commitCompact } from "../../../compact/compact";
import {
  parseStepUsage,
  estimateContextTokens,
  shouldAutoCompact,
  COMPACT_MIN_NEW_MESSAGES,
} from "../../../compact/index";
import type { CompactResult } from "../../../compact/compact";

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

/**
 * Creates a `beforeModelBuild` hook that automatically triggers context
 * compaction when the conversation grows past 75% of the model's context
 * window.
 *
 * Returns both the hook function and the circuit breaker instance so that
 * the `/compact` command (Task 6) can call `circuitBreaker.reset()` after a
 * successful manual compact.
 */
export function createAutoCompactHook(): AutoCompactHookResult {
  const circuitBreaker = createCircuitBreaker(3);
  let isCompacting = false;

  const hook = async (ctx: BeforeModelBuildContext): Promise<void> => {
    // Guard: prevent recursive auto-compact
    if (isCompacting) return;

    const state = ctx.store.getState();

    // --- Determine current token count ---
    // Prefer the latest step's usage.promptTokens (most accurate)
    const latestStep = state.steps.at(-1);
    const usageTokens = latestStep?.usage
      ? parseStepUsage(latestStep.usage)?.promptTokens
      : undefined;

    // Fallback: estimate from projected messages + systemPrompt
    const estimatedTokens = estimateContextTokens(
      state.toModelMessages(),
      ctx.systemPrompt,
    );

    const currentTokens = Math.max(usageTokens ?? 0, estimatedTokens);

    // --- Check threshold ---
    if (!shouldAutoCompact(currentTokens, ctx.modelInfo.limit.context)) return;

    // --- Circuit breaker ---
    if (circuitBreaker.isOpen) return;

    // --- Hysteresis: skip if not enough new messages since last compaction ---
    const messages = state.messages;
    let lastCompactionIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.parts.some((p) => p.type === "compaction")) {
        lastCompactionIndex = i;
        break;
      }
    }

    const newMessageCount =
      lastCompactionIndex === -1
        ? messages.length
        : messages.length - lastCompactionIndex - 1;

    if (newMessageCount < COMPACT_MIN_NEW_MESSAGES) return;

    // --- Run compact ---
    isCompacting = true;
    try {
      const result: CompactResult | null = await compact(
        {
          messages: state.messages,
          contextLimit: ctx.modelInfo.limit.context,
          model: ctx.modelInfo.model,
          sessionId: state.sessionId,
        },
        ctx.abort,
      );

      if (result) {
        commitCompact(ctx.store, result);
        circuitBreaker.recordSuccess();
      }
    } catch (err) {
      // AbortError: re-throw (user cancelled or signal fired)
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      // Non-fatal: record failure, log warning, continue
      circuitBreaker.recordFailure();
      console.warn(
        `[AutoCompact] Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      isCompacting = false;
    }
  };

  return { hook, circuitBreaker };
}
