import { z } from "zod";
import { providerAdapterCatalog } from "./provider-adapter-catalog";

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

const terminalSecretBearingOptionSegments = [
  "apikey",
  "authorization",
  "byok",
  "credential",
  "password",
  "privatekey",
  "secret",
  "token",
] as const;
const pluralSecretBearingOptionSegments = [
  "apikeys",
  "authorizations",
  "credentials",
  "passwords",
  "privatekeys",
  "secrets",
] as const;

function isSecretBearingOptionKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const tokens = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const terminalMatch = terminalSecretBearingOptionSegments.some(
    (segment) =>
      normalized === segment ||
      normalized.endsWith(segment) ||
      (segment === "byok" && normalized.startsWith(segment)),
  );
  const pluralMatch = pluralSecretBearingOptionSegments.some(
    (segment) => normalized === segment || normalized.endsWith(segment),
  ) || normalized === "tokens";
  const compoundKeyMatch = tokens.some((token, index) =>
    (token === "api" && tokens[index + 1] === "key")
    || (token === "private" && tokens[index + 1] === "key")
    || (token === "access" && tokens[index + 1] === "key"),
  );
  const qualifiedSecretMatch = tokens.some((token, index) =>
    ["authorization", "credential", "credentials", "password", "secret", "token", "tokens"].includes(token)
    && ["content", "contents", "data", "file", "header", "id", "json", "key", "pem", "provider", "raw", "text", "value"].includes(tokens[index + 1] ?? ""),
  );
  return terminalMatch || pluralMatch || compoundKeyMatch || qualifiedSecretMatch;
}

/** Return paths under a model call's providerOptions that must not contain credentials. */
export function findSecretBearingProviderOptionPaths(
  value: unknown,
  path = "providerOptions",
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findSecretBearingProviderOptionPaths(item, `${path}[${index}]`),
    );
  }

  if (value === null || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const nestedPath = path.length === 0 ? key : `${path}.${key}`;
    return [
      ...(isSecretBearingOptionKey(key) ? [nestedPath] : []),
      ...findSecretBearingProviderOptionPaths(nestedValue, nestedPath),
    ];
  });
}

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
    timeout: z.number().int().nonnegative().optional(),
    providerOptions: z.record(z.string(), z.json()).optional(),
  })
  .strict()
  .superRefine((options, context) => {
    for (const path of findSecretBearingProviderOptionPaths(
      options.providerOptions,
    )) {
      context.addIssue({
        code: "custom",
        path: ["providerOptions"],
        message: `Provider call options must not contain secrets (${path})`,
      });
    }
  });

export const modelConfigSchema = z
  .object({
    name: z.string().min(1),
    limit: modelLimitSchema,
    modalities: modelModalitiesSchema,
    options: modelCallOptionsSchema.optional(),
    variants: z.record(z.string(), modelCallOptionsSchema).optional(),
  })
  .strict();

/** Provider factory options are adapter-specific JSON values. */
export const providerOptionsSchema = z
  .object({
    baseURL: z.string().optional(),
    apiKey: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
  })
  .catchall(z.json());

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
    const available = providerAdapterCatalog
      .list()
      .map((adapter) => adapter.npmPackage)
      .join(", ");
    super(
      `Unsupported provider npm package: "${npmPackage}". Available adapters: ${available}.`,
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
 * Create an AI SDK ProviderV3 instance using its package adapter.
 */
export function createProviderInstance(
  providerId: string,
  provider: ProviderConfig,
) {
  const adapter = providerAdapterCatalog.get(provider.npm);
  if (!adapter) {
    throw new UnsupportedProviderPackageError(provider.npm);
  }

  return adapter.create({
    providerId,
    options: provider.options,
  });
}
