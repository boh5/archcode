import type { StoreApi } from "zustand";
import type { CircuitBreaker } from "../compact/circuit-breaker";
import { compact, commitCompact } from "../compact/compact";
import type { ModelCallOptions } from "../config/index";
import { silentLogger, type Logger } from "../logger";
import type { ModelInfo } from "../provider/model";
import type { SessionStoreState, StoredMessage } from "../store/types";
import type { CommandDescriptor } from "./types";

export function createCompactCommand(
  store: StoreApi<SessionStoreState>,
  modelInfo: ModelInfo,
  circuitBreaker?: CircuitBreaker,
  modelOptions?: ModelCallOptions,
  logger: Logger = silentLogger,
): CommandDescriptor {
  let isCompacting = false;

  return {
    name: "compact",
    description: "Compact conversation context into a summary.",
    handler: async (ctx, _args) => {
      if (isCompacting) {
        return { success: false, message: "Compact already in progress" };
      }

      isCompacting = true;

      const activeLogger = ctx.logger ?? logger;

      try {
        const activeStore = ctx.store ?? store;
        const activeModelInfo = ctx.modelInfo ?? modelInfo;
        const activeModelOptions = ctx.modelOptions ?? modelOptions;
        const activeCircuitBreaker = ctx.circuitBreaker ?? circuitBreaker;
        const beforeMessages = activeStore.getState().messages;
        const result = await compact(
          {
            messages: beforeMessages,
            contextLimit: activeModelInfo.limit.context,
            model: activeModelInfo.model,
            modelOptions: activeModelOptions,
            sessionId: activeStore.getState().sessionId,
            logger: activeLogger,
          },
          ctx.abort,
        );

        if (result === null) {
          return { success: false, message: "Not enough messages to compact" };
        }

        const counts = countCompactedAndTailMessages(beforeMessages, result.tailStartId);
        commitCompact(activeStore, result);
        activeCircuitBreaker?.reset();

        return {
          success: true,
          message: `Context compacted. ${counts.compacted} messages summarized. ${counts.tail} messages preserved in tail.`,
        };
      } catch (err) {
        activeLogger.warn("compact.command.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          success: false,
          message: `Compact failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        isCompacting = false;
      }
    },
  };
}

function countCompactedAndTailMessages(
  messages: readonly StoredMessage[],
  tailStartId: string,
): { compacted: number; tail: number } {
  const tailStartIndex = messages.findIndex((message) => message.id === tailStartId);
  if (tailStartIndex === -1) {
    return { compacted: messages.length, tail: 0 };
  }

  return {
    compacted: tailStartIndex,
    tail: messages.length - tailStartIndex,
  };
}
