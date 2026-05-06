import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Tool } from "ai";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/types";

export type ToolExecutor<I = unknown> = (input: I) => Promise<string>;

export type ToolExecutorMap = Record<string, ToolExecutor>;

export interface QueryLoopOptions {
  model: LanguageModelV3;
  tools: Record<string, Tool>;
  toolExecutors: ToolExecutorMap;
  systemPrompt?: string;
  maxSteps?: number;
  store: StoreApi<SessionStoreState>;
}

export interface QueryLoopResult {
  text: string;
  steps: number;
}
