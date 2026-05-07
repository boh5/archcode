import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/types";
import type { ToolRegistry } from "../../tools/registry";

export interface QueryLoopOptions {
  model: LanguageModelV3;
  toolRegistry: ToolRegistry;
  agentTools?: readonly string[];
  abort?: AbortSignal;
  systemPrompt?: string;
  maxSteps?: number;
  store: StoreApi<SessionStoreState>;
}

export interface QueryLoopResult {
  text: string;
  steps: number;
}
