import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ModelCallOptions } from "../config/provider";
import { AI_SDK_MANAGED_MAX_RETRIES } from "./constants";

export type SafeModelCallOptions = Omit<ModelCallOptions, "providerOptions" | "maxRetries"> & {
  providerOptions?: ProviderOptions;
  maxRetries: 0;
};

export function pickModelCallOptions(modelOptions: ModelCallOptions | undefined): SafeModelCallOptions {
  return {
    ...(modelOptions?.maxOutputTokens !== undefined ? { maxOutputTokens: modelOptions.maxOutputTokens } : {}),
    ...(modelOptions?.temperature !== undefined ? { temperature: modelOptions.temperature } : {}),
    ...(modelOptions?.topP !== undefined ? { topP: modelOptions.topP } : {}),
    ...(modelOptions?.topK !== undefined ? { topK: modelOptions.topK } : {}),
    ...(modelOptions?.presencePenalty !== undefined ? { presencePenalty: modelOptions.presencePenalty } : {}),
    ...(modelOptions?.frequencyPenalty !== undefined ? { frequencyPenalty: modelOptions.frequencyPenalty } : {}),
    ...(modelOptions?.stopSequences !== undefined ? { stopSequences: modelOptions.stopSequences } : {}),
    ...(modelOptions?.seed !== undefined ? { seed: modelOptions.seed } : {}),
    ...(modelOptions?.timeout !== undefined ? { timeout: modelOptions.timeout } : {}),
    ...(modelOptions?.providerOptions !== undefined ? { providerOptions: modelOptions.providerOptions as ProviderOptions } : {}),
    maxRetries: AI_SDK_MANAGED_MAX_RETRIES,
  };
}
