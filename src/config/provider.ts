import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

/** The only provider npm package supported at the moment. */
export const OPENAI_COMPATIBLE_PROVIDER_PACKAGE = "@ai-sdk/openai-compatible";

export const modelModalitySchema = z.enum(["text", "image", "audio", "video"]);

export const modelLimitSchema = z
  .object({
    context: z.number().int().positive(),
    output: z.number().int().positive(),
  })
  .strict();

export const modelModalitiesSchema = z
  .object({
    input: z.array(modelModalitySchema).min(1),
    output: z.array(modelModalitySchema).min(1),
  })
  .strict();

export const modelCallOptionsSchema = z
  .object({
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().positive().optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    stopSequences: z.array(z.string()).optional(),
    seed: z.number().int().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    timeout: z.number().int().nonnegative().optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const modelConfigSchema = z
  .object({
    name: z.string().min(1),
    limit: modelLimitSchema,
    modalities: modelModalitiesSchema,
    options: modelCallOptionsSchema.optional(),
    variants: z.record(z.string(), modelCallOptionsSchema).optional(),
  })
  .strict();

export const providerOptionsSchema = z
  .object({
    baseURL: z.string().url("Provider baseURL must be a valid URL"),
    apiKey: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const providerConfigSchema = z
  .object({
    npm: z.string().min(1),
    name: z.string().min(1),
    options: providerOptionsSchema,
    models: z.record(z.string().min(1), modelConfigSchema).refine(
      (models) => Object.keys(models).length > 0,
      "Provider must define at least one model",
    ),
  })
  .strict();

export const providersConfigSchema = z
  .record(z.string().min(1), providerConfigSchema)
  .refine(
    (providers) => Object.keys(providers).length > 0,
    "Config must define at least one provider",
  );

// Types

export type ModelModality = z.infer<typeof modelModalitySchema>;
export type ModelLimit = z.infer<typeof modelLimitSchema>;
export type ModelModalities = z.infer<typeof modelModalitiesSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ProviderOptions = z.infer<typeof providerOptionsSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProvidersConfig = z.infer<typeof providersConfigSchema>;

export type ModelCallOptions = z.infer<typeof modelCallOptionsSchema>;

export class UnsupportedProviderPackageError extends Error {
  constructor(public readonly npmPackage: string) {
    super(
      `Unsupported provider npm package: "${npmPackage}". Only "${OPENAI_COMPATIBLE_PROVIDER_PACKAGE}" is supported.`,
    );
    this.name = "UnsupportedProviderPackageError";
  }
}

export class UnknownProviderError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly availableIds: string[],
  ) {
    super(
      `Unknown provider "${providerId}". Available: ${availableIds.join(", ")}`,
    );
    this.name = "UnknownProviderError";
  }
}

export class UnknownModelError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly providerId: string,
    public readonly availableIds: string[],
  ) {
    super(
      `Unknown model "${modelId}" on provider "${providerId}". Available: ${availableIds.join(", ")}`,
    );
    this.name = "UnknownModelError";
  }
}

/**
 * Get a provider config by its ID, throwing if not found.
 */
export function getProviderConfig(
  providers: ProvidersConfig,
  providerId: string,
): ProviderConfig {
  const config = providers[providerId];
  if (!config) {
    throw new UnknownProviderError(providerId, Object.keys(providers));
  }
  return config;
}

/**
 * Get a model config from a provider, throwing if not found.
 */
export function getModelConfig(
  provider: ProviderConfig,
  modelId: string,
): ModelConfig {
  const config = provider.models[modelId];
  if (!config) {
    throw new UnknownModelError(modelId, provider.name, Object.keys(provider.models));
  }
  return config;
}

/**
 * Create an AI SDK provider instance from a provider config.
 * Currently only `@ai-sdk/openai-compatible` is supported.
 */
export function createProviderInstance(provider: ProviderConfig) {
  if (provider.npm !== OPENAI_COMPATIBLE_PROVIDER_PACKAGE) {
    throw new UnsupportedProviderPackageError(provider.npm);
  }

  return createOpenAICompatible({
    name: provider.name,
    baseURL: provider.options.baseURL,
    apiKey: provider.options.apiKey,
    headers: provider.options.headers,
    queryParams: provider.options.queryParams,
  });
}

/**
 * Convenience: create a language model (chat model) directly from a full
 * config, provider ID, and model ID.
 */
export function createLanguageModel(
  providers: ProvidersConfig,
  providerId: string,
  modelId: string,
) {
  const providerConfig = getProviderConfig(providers, providerId);
  getModelConfig(providerConfig, modelId);
  return createProviderInstance(providerConfig).chatModel(modelId);
}
