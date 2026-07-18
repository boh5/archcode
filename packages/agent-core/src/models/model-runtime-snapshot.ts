import type {
  ModelRuntimeCatalog,
  ModelSelectionRef,
} from "@archcode/protocol";
import type {
  AgentConfig,
  ArchCodeConfig,
  ModelConfig,
} from "../config";
import type { ModelInfo, ProviderRegistry } from "../provider";
import { cloneAndFreeze, deepFreeze } from "./immutable";

interface SnapshotModel {
  readonly info: ModelInfo;
  readonly config: ModelConfig;
}

export interface ResolvedSnapshotSelection {
  readonly selection: ModelSelectionRef;
  readonly modelInfo: ModelInfo;
  readonly modelConfig: ModelConfig;
}

export interface ModelRuntimeSnapshotOptions {
  readonly revision: string;
  readonly config: ArchCodeConfig;
  readonly providerRegistry: ProviderRegistry;
}

export class InvalidModelRuntimeSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelRuntimeSnapshotError";
  }
}

/** Immutable configuration and model metadata used to claim new Executions. */
export class ModelRuntimeSnapshot {
  readonly revision: string;
  readonly catalog: ModelRuntimeCatalog;

  readonly #models: ReadonlyMap<string, SnapshotModel>;
  readonly #agents: ReadonlyMap<string, AgentConfig>;
  readonly #providerDisplayNames: ReadonlyMap<string, string>;

  constructor(options: ModelRuntimeSnapshotOptions) {
    const config = cloneAndFreeze(options.config);
    const models = new Map<string, SnapshotModel>();

    for (const [providerId, provider] of Object.entries(config.provider)) {
      for (const [modelId, modelConfig] of Object.entries(provider.models)) {
        const qualifiedId = `${providerId}:${modelId}`;
        const modelInfo = options.providerRegistry.models.get(qualifiedId);
        if (!modelInfo) {
          throw new InvalidModelRuntimeSnapshotError(
            `Configured model "${qualifiedId}" is absent from the Provider registry`,
          );
        }
        models.set(qualifiedId, { info: modelInfo, config: modelConfig });
      }
    }

    const agents = new Map(
      Object.entries(config.agents as Record<string, AgentConfig>),
    );

    this.revision = options.revision;
    this.#models = models;
    this.#agents = agents;
    this.#providerDisplayNames = new Map(
      Object.entries(config.provider).map(([providerId, provider]) => [
        providerId,
        provider.name,
      ]),
    );

    for (const [agentName, agent] of agents) {
      if (!this.tryResolveSelection({ model: agent.model, variant: agent.variant })) {
        throw new InvalidModelRuntimeSnapshotError(
          `Agent "${agentName}" has invalid default selection "${formatSelection(agent)}"`,
        );
      }
    }

    this.catalog = buildCatalog(config, options.revision);
    Object.freeze(this);
  }

  getAgentDefault(agentName: string): ModelSelectionRef | undefined {
    const agent = this.#agents.get(agentName);
    if (!agent) return undefined;
    return freezeSelection({ model: agent.model, variant: agent.variant });
  }

  getAgentOptions(agentName: string): AgentConfig["options"] {
    return this.#agents.get(agentName)?.options;
  }

  getProviderDisplayName(providerId: string): string {
    const displayName = this.#providerDisplayNames.get(providerId);
    if (displayName === undefined) {
      throw new InvalidModelRuntimeSnapshotError(
        `Provider "${providerId}" is absent from the model runtime snapshot`,
      );
    }
    return displayName;
  }

  tryResolveSelection(selection: ModelSelectionRef): ResolvedSnapshotSelection | undefined {
    const model = this.#models.get(selection.model);
    if (!model) return undefined;

    if (
      selection.variant !== undefined
      && !Object.prototype.hasOwnProperty.call(model.config.variants ?? {}, selection.variant)
    ) {
      return undefined;
    }

    return Object.freeze({
      selection: freezeSelection(selection),
      modelInfo: model.info,
      modelConfig: model.config,
    });
  }
}

function buildCatalog(
  config: ArchCodeConfig,
  revision: string,
): ModelRuntimeCatalog {
  const providers = Object.entries(config.provider).map(([providerId, provider]) => ({
    id: providerId,
    displayName: provider.name,
    models: Object.entries(provider.models).map(([modelId, model]) => ({
      id: modelId,
      qualifiedId: `${providerId}:${modelId}`,
      displayName: model.name,
      variants: Object.keys(model.variants ?? {}),
    })),
  }));
  const agentDefaults = Object.fromEntries(
    Object.entries(config.agents as Record<string, AgentConfig>).map(([agentName, agent]) => [
      agentName,
      { model: agent.model, variant: agent.variant },
    ]),
  );

  return deepFreeze({ revision, providers, agentDefaults });
}

function freezeSelection(selection: ModelSelectionRef): ModelSelectionRef {
  return Object.freeze({
    model: selection.model,
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
  });
}

function formatSelection(selection: ModelSelectionRef): string {
  return selection.variant === undefined
    ? selection.model
    : `${selection.model} (${selection.variant})`;
}
