import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
  ModelConfig,
  ModelCapabilities,
  ModelLimit,
  ModelModalities,
} from "../config/index";

/**
 * Wraps an AI SDK LanguageModel instance together with its static metadata
 * from the config file (display name, context/output limits, modalities).
 *
 * Downstream modules (agents, core) receive `ModelInfo` objects so they can
 * inspect capabilities without reaching back into the raw config.
 */
export class ModelInfo {
  /** The AI SDK language model — pass directly to `generateText` / `streamText`. */
  readonly model: LanguageModelV3;

  /** Human-readable name from config (e.g. "GPT-5.2"). */
  readonly displayName: string;

  /** Context window & max output token limits. */
  readonly limit: ModelLimit;

  /** Supported input/output modalities. */
  readonly modalities: ModelModalities;

  /** Explicit model behavior used only by the small prompt overlay. */
  readonly capabilities: ModelCapabilities;

  /** The provider ID this model belongs to (e.g. "xxx"). */
  readonly providerId: string;

  /** The model ID within its provider (e.g. "gpt-5.2"). */
  readonly modelId: string;

  constructor(options: {
    model: LanguageModelV3;
    config: ModelConfig;
    providerId: string;
    modelId: string;
  }) {
    this.model = options.model;
    this.displayName = options.config.name;
    this.limit = options.config.limit;
    this.modalities = options.config.modalities;
    this.capabilities = options.config.capabilities;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
  }

  /** Fully qualified identifier: `"providerId:modelId"` */
  get qualifiedId(): string {
    return `${this.providerId}:${this.modelId}`;
  }
}
