import type { StoreApi } from "zustand";
import type { CircuitBreaker } from "../compact/circuit-breaker";
import { prepareHardLimitCompression } from "../compression";
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
        const result = await prepareHardLimitCompression({
          storeState: activeStore.getState(),
          model: activeModelInfo.model,
          modelOptions: activeModelOptions,
          abort: ctx.abort,
          logger: activeLogger,
          strategy: "hard-limit",
          trigger: "manual_command",
        });

        activeStore.getState().append(result.event);
        if (!result.ok) {
          return { success: false, message: result.code === "no_safe_range" ? "No safe range to compact" : `Compact failed: ${result.reason}` };
        }

        activeCircuitBreaker?.reset();

        const compacted = result.block.range.endIndex - result.block.range.startIndex + 1;
        const tail = Math.max(0, beforeMessages - result.block.range.endIndex - 1);
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
