import type { ZodType } from "zod/v4";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelMessage, StreamTextResult, ToolSet } from "ai";
import type { ModelCallOptions } from "../config/provider";
import type { Logger } from "../logger";
import type { RetryScheduler } from "./retry";

export interface LlmStreamInput<TTools extends ToolSet = ToolSet> {
  model: LanguageModelV3;
  messages: ModelMessage[];
  system?: string;
  tools?: TTools;
  abortSignal?: AbortSignal;
  modelOptions?: ModelCallOptions;
}

export type LlmStreamResult<TTools extends ToolSet = ToolSet> = StreamTextResult<TTools, never>;

export interface LlmTextInput {
  model: LanguageModelV3;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  abortSignal?: AbortSignal;
  modelOptions?: ModelCallOptions;
  logger?: Logger;
  retryScheduler?: RetryScheduler;
}

export interface LlmTextResult {
  text: string;
}

export interface LlmObjectInput<T> {
  model: LanguageModelV3;
  schema: ZodType<T>;
  system?: string;
  prompt: string;
  abortSignal?: AbortSignal;
  modelOptions?: ModelCallOptions;
  logger?: Logger;
  retryScheduler?: RetryScheduler;
  /** Schema name used in tool definition (defaults to "result") */
  schemaName?: string;
  /** Schema description used in tool definition */
  schemaDescription?: string;
}
