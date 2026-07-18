import type { StoreApi } from "zustand";
import { compact, commitCompact, type CircuitBreaker } from "../compact";
import type { ModelCallOptions } from "../config/index";
import { silentLogger, type Logger } from "../logger";
import type { ModelInfo } from "../provider/model";
import type { SessionStoreState } from "../store/types";
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
        const beforeMessages = activeStore.getState().messages.length;
        const state = activeStore.getState();
        const result = await compact({
          messages: state.messages,
          contextLimit: activeModelInfo.limit.context,
          model: activeModelInfo.model,
          modelOptions: activeModelOptions,
          logger: activeLogger,
        }, ctx.abort);

        if (result === null) {
          return { success: false, message: "No safe range to compact" };
        }

        const tailStartIndex = state.messages.findIndex((message) => message.id === result.tailStartId);
        const compacted = tailStartIndex === -1 ? beforeMessages : tailStartIndex;
        const tail = tailStartIndex === -1 ? 0 : Math.max(0, beforeMessages - tailStartIndex);

        commitCompact(activeStore, result);
        activeCircuitBreaker?.reset();

        return {
          success: true,
          message: `Context compacted. ${compacted} messages summarized. ${tail} messages preserved in tail.`,
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
