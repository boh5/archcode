import type { StoreApi } from "zustand";
import { estimateContextTokens, parseStepUsage } from "../compact";
import type { SessionStoreState } from "../store/types";

export interface CompressionTokenPressure {
  readonly currentTokens: number;
  readonly contextLimit: number;
  readonly ratio: number;
  readonly source: "usage" | "estimate";
}

export function getCompressionTokenPressure(
  store: StoreApi<SessionStoreState>,
  contextLimit: number | undefined,
  systemPrompt?: string,
): CompressionTokenPressure | null {
  if (typeof contextLimit !== "number" || contextLimit <= 0) return null;

  const state = store.getState();
  const usageTokens = latestPromptOrContextUsageTokens(state);
  if (usageTokens !== undefined) {
    return {
      currentTokens: usageTokens,
      contextLimit,
      ratio: usageTokens / contextLimit,
      source: "usage",
    };
  }

  const estimatedTokens = estimateContextTokens(state.toModelMessages(), systemPrompt);
  return {
    currentTokens: estimatedTokens,
    contextLimit,
    ratio: estimatedTokens / contextLimit,
    source: "estimate",
  };
}

function latestPromptOrContextUsageTokens(state: SessionStoreState): number | undefined {
  for (let index = state.steps.length - 1; index >= 0; index -= 1) {
    const usage = state.steps[index]?.usage;
    const parsed = usage === undefined ? null : parseStepUsage(usage);
    const tokens = parsed?.promptTokens ?? parsed?.totalTokens;
    if (typeof tokens === "number" && tokens > 0) return tokens;
  }
  return undefined;
}
