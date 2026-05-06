import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Tool, ModelMessage } from "ai";
import type { StoreApi } from "zustand";
import type { SessionTranscriptState } from "../../store/types.js";

export type ToolExecutor<I = unknown> = (input: I) => Promise<string>;

export type ToolExecutorMap = Record<string, ToolExecutor>;

export interface QueryLoopOptions {
  model: LanguageModelV3;
  tools: Record<string, Tool>;
  toolExecutors: ToolExecutorMap;
  systemPrompt?: string;
  maxSteps?: number;
  store: StoreApi<SessionTranscriptState>;
}

export interface QueryLoopResult {
  text: string;
  messages: ModelMessage[];
  steps: number;
}
