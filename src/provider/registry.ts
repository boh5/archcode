import { createProviderRegistry } from "ai";
import type { ProviderRegistryProvider } from "ai";
import type { ProvidersConfig } from "../config/index.js";
import {
  createProviderInstance,
  getProviderConfig,
  getModelConfig,
} from "../config/index.js";
import { ModelInfo } from "./model.js";

export class UnknownQualifiedIdError extends Error {
  constructor(
    public readonly qualifiedId: string,
    public readonly availableIds: string[],
  ) {
    super(
      `Unknown model "${qualifiedId}". Available: ${availableIds.join(", ")}`,
    );
    this.name = "UnknownQualifiedIdError";
  }
}

/**
 * Central access point for all configured LLM providers and their models.
 *
 * Built from a validated `ProvidersConfig` — call {@link createRegistry} or
 * {@link createRegistryFromFile} to obtain an instance.
 */
export class Registry {
  /** The underlying AI SDK provider registry (`registry.languageModel("p:m")`). */
  readonly sdkRegistry: ProviderRegistryProvider;

  /** All models keyed by `"providerId:modelId"`. */
  readonly models: ReadonlyMap<string, ModelInfo>;

  constructor(
    sdkRegistry: ProviderRegistryProvider,
    models: Map<string, ModelInfo>,
  ) {
    this.sdkRegistry = sdkRegistry;
    this.models = models;
  }

  /** Get a model by its qualified id (`"providerId:modelId"`). */
  getModel(qualifiedId: string): ModelInfo {
    const info = this.models.get(qualifiedId);
    if (!info) {
      throw new UnknownQualifiedIdError(
        qualifiedId,
        Array.from(this.models.keys()),
      );
    }
    return info;
  }

  /** All available qualified model ids. */
  get modelIds(): string[] {
    return Array.from(this.models.keys());
  }
}

/**
 * Build a {@link Registry} from an already-loaded `ProvidersConfig`.
 *
 * Iterates every provider → every model, creates AI SDK provider instances,
 * and indexes all resulting `ModelInfo` objects by qualified id.
 *
 * @example
 * ```ts
 * import { loadConfig } from "../config/index.js";
 * import { createRegistry } from "./provider/index.js";
 * import { generateText } from "ai";
 *
 * const config = await loadConfig(".specra.json");
 * const registry = createRegistry(config.provider);
 *
 * const model = registry.getModel("xxx:gpt-5.2");
 *
 * const { text } = await generateText({
 *   model: model.model,  // AI SDK LanguageModelV3 instance
 *   prompt: "hello",
 * });
 *
 * model.limit.context    // 400000
 * model.modalities.input // ["text", "image"]
 * model.displayName      // "GPT-5.2"
 *
 * // Raw AI SDK registry (supports "providerId:modelId" string access)
 * registry.sdkRegistry.languageModel("xxx:gpt-5.2")
 * ```
 */
export function createRegistry(providers: ProvidersConfig): Registry {
  const sdkProviders: Record<string, ReturnType<typeof createProviderInstance>> =
    {};
  const models = new Map<string, ModelInfo>();

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const instance = createProviderInstance(providerConfig);
    sdkProviders[providerId] = instance;

    for (const modelId of Object.keys(providerConfig.models)) {
      const modelConfig = getModelConfig(providerConfig, modelId);
      const sdkModel = instance.chatModel(modelId);

      const info = new ModelInfo({
        model: sdkModel,
        config: modelConfig,
        providerId,
        modelId,
      });

      models.set(info.qualifiedId, info);
    }
  }

  const sdkRegistry = createProviderRegistry(sdkProviders);
  return new Registry(sdkRegistry, models);
}
