import { COMPACT_MIN_NEW_MESSAGES, compact, commitCompact, createCircuitBreaker, type CircuitBreaker } from "../../../compact";
import type { Logger } from "../../../logger";
import { TOOL_OUTPUT_DIR } from "../../../tools/persist-output";
import {
  HARD_COMPACT_RATIO,
  SOFT_NUDGE_RATIO,
  STRONG_NUDGE_RATIO,
  getCompressionTokenPressure,
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
      const result = await compact({
        messages: state.messages,
        contextLimit: ctx.modelInfo.limit.context,
        model: ctx.modelInfo.model,
        modelOptions: ctx.modelOptions,
        sessionId: state.sessionId,
        logger,
        toolOutputDir: TOOL_OUTPUT_DIR,
      }, ctx.abort);

      if (result === null) {
        circuitBreaker.recordFailure();
        logger.debug("compact.auto.skipped", { context: { reason: "no_compactable_prefix", ratio: pressure.ratio } });
        return;
      }

      commitCompact(ctx.store, result);
      lastCommittedMessageCount = ctx.store.getState().messages.length;
      circuitBreaker.recordSuccess();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      circuitBreaker.recordFailure();
      logger.warn("compact.auto.failed", { error });
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
    ? "Context pressure is high. Dynamic compression is an in-conversation tool action: use the compress tool on a safe older range only if it helps before the hard safety threshold. Do not compress the latest two rounds or protected content."
    : "Context pressure is rising. Keep responses concise and consider whether an older safe range should be dynamically compressed later.";
  return {
    role: "user",
    content: [{ type: "text", text: `<system-reminder>\nDynamic compression ${strength} nudge at ${percent}% context pressure. ${guidance}\n</system-reminder>` }],
  };
}
