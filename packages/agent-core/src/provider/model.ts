import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
  ModelConfig,
  ModelCapabilities,
  ModelLimit,
  ModelModalities,
} from "../config/index";
import { SensitiveValueRedactor, type StreamingSensitiveTextRedactor } from "./sensitive-value-redactor";

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

  /** Human-readable provider name from config, separate from its namespace ID. */
  readonly providerDisplayName: string;

  /** The model ID within its provider (e.g. "gpt-5.2"). */
  readonly modelId: string;

  readonly #sensitiveValueRedactor: SensitiveValueRedactor;

  constructor(options: {
    model: LanguageModelV3;
    config: ModelConfig;
    providerId: string;
    providerDisplayName?: string;
    modelId: string;
    providerSecretValues?: readonly string[];
  }) {
    this.model = options.model;
    this.displayName = options.config.name;
    this.limit = Object.freeze({ ...options.config.limit });
    this.modalities = Object.freeze({
      input: Object.freeze([...options.config.modalities.input]),
      output: Object.freeze([...options.config.modalities.output]),
    }) as unknown as ModelModalities;
    this.capabilities = Object.freeze({ ...options.config.capabilities });
    this.providerId = options.providerId;
    this.providerDisplayName = options.providerDisplayName ?? options.providerId;
    this.modelId = options.modelId;
    this.#sensitiveValueRedactor = new SensitiveValueRedactor(options.providerSecretValues ?? []);
    Object.freeze(this);
  }

  redactSensitiveText(text: string): string {
    return this.#sensitiveValueRedactor.redact(text);
  }

  redactSensitiveValue<T>(value: T): T {
    return this.#sensitiveValueRedactor.redactValue(value);
  }

  createSensitiveTextStream(): StreamingSensitiveTextRedactor {
    return this.#sensitiveValueRedactor.createTextStream();
  }

  /** Fully qualified identifier: `"providerId:modelId"` */
  get qualifiedId(): string {
    return `${this.providerId}:${this.modelId}`;
  }
}
