import type { ZodType } from "zod/v4";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelCallOptions } from "../config/provider";
import type { Logger } from "../logger";

export interface LlmObjectInput<T> {
  model: LanguageModelV3;
  schema: ZodType<T>;
  system?: string;
  prompt: string;
  abortSignal?: AbortSignal;
  modelOptions?: ModelCallOptions;
  logger?: Logger;
  /** Schema name used in tool definition (defaults to "result") */
  schemaName?: string;
  /** Schema description used in tool definition */
  schemaDescription?: string;
}
