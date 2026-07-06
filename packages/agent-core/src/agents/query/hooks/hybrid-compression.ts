import type { CircuitBreaker } from "../../../compact/circuit-breaker";
import { createCircuitBreaker } from "../../../compact/circuit-breaker";
import { COMPACT_MIN_NEW_MESSAGES } from "../../../compact/token-estimation";
import type { Logger } from "../../../logger";
import {
  EMERGENCY_COMPACT_RATIO,
  HARD_COMPACT_RATIO,
  SOFT_NUDGE_RATIO,
  STRONG_NUDGE_RATIO,
  getCompressionTokenPressure,
  prepareEmergencyCompression,
  prepareHardLimitCompression,
} from "../../../compression";
import type { BeforeModelBuildContext, BeforeModelCallContext } from "../loop-hooks";

type ModelCallMessage = BeforeModelCallContext["messages"][number];

export interface HybridCompressionHookResult {
  readonly beforeModelBuild: (ctx: BeforeModelBuildContext) => Promise<void>;
  readonly beforeModelCall: (ctx: BeforeModelCallContext) => Promise<void>;
  readonly circuitBreaker: CircuitBreaker;
}

export function createHybridCompressionHook(logger: Logger): HybridCompressionHookResult {
  const circuitBreaker = createCircuitBreaker(3);
  let isCompressing = false;
  let lastCommittedMessageCount: number | undefined;

  const beforeModelBuild = async (ctx: BeforeModelBuildContext): Promise<void> => {
    if (isCompressing || circuitBreaker.isOpen) return;
    const pressure = getCompressionTokenPressure(ctx.store, ctx.modelInfo.limit.context, ctx.systemPrompt);
    if (pressure === null || pressure.ratio < HARD_COMPACT_RATIO) return;

    const messageCount = ctx.store.getState().messages.length;
    if (lastCommittedMessageCount !== undefined && messageCount - lastCommittedMessageCount < COMPACT_MIN_NEW_MESSAGES) return;

    isCompressing = true;
    try {
      const state = ctx.store.getState();
      const result = pressure.ratio >= EMERGENCY_COMPACT_RATIO
        ? await prepareEmergencyCompression({ storeState: state, model: ctx.modelInfo.model, modelOptions: ctx.modelOptions, abort: ctx.abort, logger })
        : await prepareHardLimitCompression({ storeState: state, model: ctx.modelInfo.model, modelOptions: ctx.modelOptions, abort: ctx.abort, logger });

      ctx.store.getState().append(result.event);
      if (result.ok) {
        lastCommittedMessageCount = messageCount;
        circuitBreaker.recordSuccess();
      } else {
        circuitBreaker.recordFailure();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      circuitBreaker.recordFailure();
      logger.warn("compression.hybrid.failed", { error });
    } finally {
      isCompressing = false;
    }
  };

  const beforeModelCall = async (ctx: BeforeModelCallContext): Promise<void> => {
    const pressure = getCompressionTokenPressure(ctx.store, ctx.modelInfo.limit.context);
    if (pressure === null || pressure.ratio < SOFT_NUDGE_RATIO || pressure.ratio >= HARD_COMPACT_RATIO) return;
    const strength = pressure.ratio >= STRONG_NUDGE_RATIO ? "strong" : "soft";
    ctx.messages.push(compressionNudgeMessage(strength, pressure.ratio));
  };

  return { beforeModelBuild, beforeModelCall, circuitBreaker };
}

function compressionNudgeMessage(strength: "soft" | "strong", ratio: number): ModelCallMessage {
  const percent = Math.floor(ratio * 100);
  const guidance = strength === "strong"
    ? "Context pressure is high. Prefer using the compress tool on a safe older range after this response if it helps preserve working context. Do not compress the latest two rounds or protected content."
    : "Context pressure is rising. Keep responses concise and consider whether an older safe range should be compressed later.";
  return {
    role: "user",
    content: [{ type: "text", text: `<system-reminder>\nHybrid compression ${strength} nudge at ${percent}% context pressure. ${guidance}\n</system-reminder>` }],
  };
}
