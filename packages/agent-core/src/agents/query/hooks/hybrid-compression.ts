import { COMPACT_MIN_NEW_MESSAGES, compact, commitCompact, createCircuitBreaker, type CircuitBreaker } from "../../../compact";
import type { Logger } from "../../../logger";
import type { ToolOutputAccessService } from "../../../tool-output/access-service";
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
  readonly scheduleToolOutputRecoveryNotice: () => Promise<void>;
}

export function createHybridCompressionHook(
  logger: Logger,
  toolOutputAccess: ToolOutputAccessService,
): HybridCompressionHookResult {
  const circuitBreaker = createCircuitBreaker(3);
  let isCompressing = false;
  let lastCommittedMessageCount: number | undefined;
  let pendingRecoverableArtifactCount: number | undefined;

  const scheduleToolOutputRecoveryNotice = async (): Promise<void> => {
    pendingRecoverableArtifactCount = await toolOutputAccess.countRecoverable();
  };

  const beforeModelBuild = async (ctx: BeforeModelBuildContext): Promise<void> => {
    if (isCompressing || circuitBreaker.isOpen) return;
    const pressure = getCompressionTokenPressure(ctx.store, ctx.binding.modelInfo.limit.context, ctx.systemPrompt);
    if (pressure === null || pressure.ratio < HARD_COMPACT_RATIO) return;

    const messageCount = ctx.store.getState().messages.length;
    if (lastCommittedMessageCount !== undefined && messageCount - lastCommittedMessageCount < COMPACT_MIN_NEW_MESSAGES) return;

    isCompressing = true;
    try {
      const state = ctx.store.getState();
      const result = await compact({
        messages: state.messages,
        binding: ctx.binding,
        logger,
      }, ctx.abort);

      if (result === null) {
        circuitBreaker.recordFailure();
        logger.debug("compact.auto.skipped", { context: { reason: "no_compactable_prefix", ratio: pressure.ratio } });
        return;
      }

      commitCompact(ctx.store, result);
      await scheduleToolOutputRecoveryNotice();
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
    if (pendingRecoverableArtifactCount !== undefined) {
      ctx.messages.push(toolOutputRecoveryNotice(pendingRecoverableArtifactCount));
      pendingRecoverableArtifactCount = undefined;
    }
    const pressure = getCompressionTokenPressure(ctx.store, ctx.binding.modelInfo.limit.context);
    if (pressure === null || pressure.ratio < SOFT_NUDGE_RATIO || pressure.ratio >= HARD_COMPACT_RATIO) return;
    const strength = pressure.ratio >= STRONG_NUDGE_RATIO ? "strong" : "soft";
    ctx.messages.push(compressionNudgeMessage(strength, pressure.ratio));
  };

  return { beforeModelBuild, beforeModelCall, circuitBreaker, scheduleToolOutputRecoveryNotice };
}

function toolOutputRecoveryNotice(count: number): ModelCallMessage {
  return {
    role: "user",
    content: [{
      type: "text",
      text: `<system-reminder>\nHard compact completed. The current Session family has ${count} recoverable tool-output artifact${count === 1 ? "" : "s"}. To rediscover prior output, call output_search without outputRef.\n</system-reminder>`,
    }],
  };
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
