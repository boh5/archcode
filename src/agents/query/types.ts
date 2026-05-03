import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Tool, ModelMessage } from "ai";

export type ToolExecutor<I = unknown> = (input: I) => Promise<string>;

export type ToolExecutorMap = Record<string, ToolExecutor>;

export interface QueryLoopOptions {
  model: LanguageModelV3;
  tools: Record<string, Tool>;
  toolExecutors: ToolExecutorMap;
  systemPrompt?: string;
  maxSteps?: number;
}

export interface QueryLoopResult {
  text: string;
  messages: ModelMessage[];
  steps: number;
}
