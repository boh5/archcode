import type { ZodType } from "zod/v4";
import type { LanguageModelV3 } from "@ai-sdk/provider";

export interface LlmObjectInput<T> {
  model: LanguageModelV3;
  schema: ZodType<T>;
  system?: string;
  prompt: string;
  abortSignal?: AbortSignal;
  /** Schema name used in tool definition (defaults to "result") */
  schemaName?: string;
  /** Schema description used in tool definition */
  schemaDescription?: string;
}
