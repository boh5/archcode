import type { ModelCallOptions, SpecraConfig } from "../config/index";
import type { ModelInfo, Registry as ProviderRegistry } from "../provider/index";
import { MissingAgentModelConfigError, UnknownModelVariantError } from "./errors";

export function resolveAgentModel(
  agentName: string,
  config: SpecraConfig,
  providerRegistry: ProviderRegistry,
): { modelInfo: ModelInfo; options: ModelCallOptions | undefined } {
  const agentConfig = config.agents?.[agentName];
  if (!agentConfig?.model) {
    throw new MissingAgentModelConfigError(agentName, Object.keys(config.agents ?? {}));
  }

  const modelInfo = providerRegistry.getModel(agentConfig.model);
  const modelConfig = config.provider[modelInfo.providerId]?.models[modelInfo.modelId];
  const variantOptions = agentConfig.variant === undefined
    ? undefined
    : modelConfig?.variants?.[agentConfig.variant];

  if (agentConfig.variant !== undefined && variantOptions === undefined) {
    throw new UnknownModelVariantError(
      agentName,
      agentConfig.model,
      agentConfig.variant,
      Object.keys(modelConfig?.variants ?? {}),
    );
  }

  const options = mergeModelCallOptions(
    modelConfig?.options,
    variantOptions,
    agentConfig.options,
  );

  return { modelInfo, options };
}

function mergeModelCallOptions(
  ...layers: Array<ModelCallOptions | undefined>
): ModelCallOptions | undefined {
  let merged: ModelCallOptions | undefined;

  for (const layer of layers) {
    if (layer === undefined) continue;
    merged = { ...merged, ...layer };
  }

  return merged;
}
