import type {
  ModelRuntimeCatalog,
  ModelSelectionRef,
} from "@archcode/protocol";
import type {
  ArchCodeConfig,
  ModelConfig,
  ProfileConfig,
  ProfileName,
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
  readonly config: Omit<ArchCodeConfig, "auth">;
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
  readonly #profiles: ReadonlyMap<ProfileName, ProfileConfig>;
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

    const profiles = new Map(
      Object.entries(config.profiles) as Array<[ProfileName, ProfileConfig]>,
    );

    this.revision = options.revision;
    this.#models = models;
    this.#profiles = profiles;
    this.#providerDisplayNames = new Map(
      Object.entries(config.provider).map(([providerId, provider]) => [
        providerId,
        provider.name,
      ]),
    );

    for (const [profileName, profile] of profiles) {
      if (!this.#models.has(profile.model)) {
        throw new InvalidModelRuntimeSnapshotError(
          `Profile "${profileName}" has unknown default model "${profile.model}"`,
        );
      }
    }

    this.catalog = buildCatalog(config, options.revision);
    Object.freeze(this);
  }

  getProfileDefault(profileName: ProfileName): ModelSelectionRef {
    const profile = this.#profiles.get(profileName);
    if (!profile) {
      throw new InvalidModelRuntimeSnapshotError(`Profile "${profileName}" is absent from the model runtime snapshot`);
    }
    const model = this.#models.get(profile.model);
    if (!model) {
      throw new InvalidModelRuntimeSnapshotError(`Profile "${profileName}" has unknown default model "${profile.model}"`);
    }
    return freezeSelection(resolvedProfileSelection(profile, model.config));
  }

  getProfileOptions(profileName: ProfileName): ProfileConfig["options"] {
    return this.#profiles.get(profileName)?.options;
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
  config: Omit<ArchCodeConfig, "auth">,
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
  const profileDefaults = {
    principal: selectionFromProfile(config, config.profiles.principal),
    deep: selectionFromProfile(config, config.profiles.deep),
    fast: selectionFromProfile(config, config.profiles.fast),
  };

  return deepFreeze({ revision, providers, profileDefaults });
}

function selectionFromProfile(
  config: Omit<ArchCodeConfig, "auth">,
  profile: ProfileConfig,
): ModelSelectionRef {
  const [providerId = "", ...modelIdParts] = profile.model.split(":");
  const model = config.provider[providerId]?.models[modelIdParts.join(":")];
  if (!model) return { model: profile.model };
  return resolvedProfileSelection(profile, model);
}

function resolvedProfileSelection(
  profile: ProfileConfig,
  model: ModelConfig,
): ModelSelectionRef {
  if (
    profile.variant === undefined
    || !Object.prototype.hasOwnProperty.call(model.variants ?? {}, profile.variant)
  ) {
    return { model: profile.model };
  }
  return { model: profile.model, variant: profile.variant };
}

function freezeSelection(selection: ModelSelectionRef): ModelSelectionRef {
  return Object.freeze({
    model: selection.model,
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
  });
}
