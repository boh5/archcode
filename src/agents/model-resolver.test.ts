import { describe, expect, test } from "bun:test";
import type { SpecraConfig } from "../config/index";
import { ModelInfo, UnknownQualifiedIdError, type Registry as ProviderRegistry } from "../provider/index";
import { MissingAgentModelConfigError, UnknownModelVariantError } from "./errors";
import { resolveAgentModel } from "./model-resolver";

const baseConfig: SpecraConfig = {
  provider: {
    test: {
      npm: "@ai-sdk/openai-compatible",
      name: "test",
      options: { baseURL: "http://localhost:8090/v1" },
      models: {
        main: {
          name: "Main Model",
          limit: { context: 1000, output: 100 },
          modalities: { input: ["text"], output: ["text"] },
          options: {
            maxOutputTokens: 100,
            temperature: 0.2,
            providerOptions: { test: { base: true } },
          },
          variants: {
            fast: {
              temperature: 0.7,
              topP: 0.9,
              providerOptions: { test: { variant: true } },
            },
            careful: {
              topK: 40,
            },
          },
        },
        bare: {
          name: "Bare Model",
          limit: { context: 2000, output: 200 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  },
  agents: {
    orchestrator: { model: "test:main" },
  },
};

function makeRegistry(config: SpecraConfig): ProviderRegistry {
  const models = new Map<string, ModelInfo>();

  for (const [providerId, providerConfig] of Object.entries(config.provider)) {
    for (const [modelId, modelConfig] of Object.entries(providerConfig.models)) {
      const info = new ModelInfo({
        model: {} as ConstructorParameters<typeof ModelInfo>[0]["model"],
        config: modelConfig,
        providerId,
        modelId,
      });
      models.set(info.qualifiedId, info);
    }
  }

  return {
    sdkRegistry: {} as ProviderRegistry["sdkRegistry"],
    models,
    get modelIds() {
      return Array.from(models.keys());
    },
    getModel(qualifiedId: string) {
      const info = models.get(qualifiedId);
      if (!info) throw new UnknownQualifiedIdError(qualifiedId, Array.from(models.keys()));
      return info;
    },
  } as ProviderRegistry;
}

function configWithAgents(agents: NonNullable<SpecraConfig["agents"]>): SpecraConfig {
  return { ...baseConfig, agents };
}

describe("resolveAgentModel", () => {
  test("returns correct ModelInfo for configured agent model", () => {
    const registry = makeRegistry(baseConfig);

    const result = resolveAgentModel("orchestrator", baseConfig, registry);

    expect(result.modelInfo).toBe(registry.getModel("test:main"));
    expect(result.modelInfo.qualifiedId).toBe("test:main");
  });

  test("merges model options, selected variant, and agent options in order", () => {
    const config = configWithAgents({
      orchestrator: {
        model: "test:main",
        variant: "fast",
        options: { maxRetries: 2, temperature: 1.1 },
      },
    });

    const result = resolveAgentModel("orchestrator", config, makeRegistry(config));

    expect(result.options).toEqual({
      maxOutputTokens: 100,
      temperature: 1.1,
      topP: 0.9,
      maxRetries: 2,
      providerOptions: { test: { variant: true } },
    });
  });

  test("shallow-replaces providerOptions at each layer", () => {
    const config = configWithAgents({
      orchestrator: {
        model: "test:main",
        variant: "fast",
        options: { providerOptions: { test: { agent: true } } },
      },
    });

    const result = resolveAgentModel("orchestrator", config, makeRegistry(config));

    expect(result.options?.providerOptions).toEqual({ test: { agent: true } });
  });

  test("throws MissingAgentModelConfigError with agent name and available agents", () => {
    const config = configWithAgents({ explorer: { model: "test:main" } });

    try {
      resolveAgentModel("orchestrator", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAgentModelConfigError);
      const typedError = error as MissingAgentModelConfigError;
      expect(typedError.name).toBe("MissingAgentModelConfigError");
      expect(typedError.agentName).toBe("orchestrator");
      expect(typedError.availableAgents).toEqual(["explorer"]);
    }
  });

  test("throws MissingAgentModelConfigError for missing explore model config", () => {
    const config = configWithAgents({ orchestrator: { model: "test:main" } });

    try {
      resolveAgentModel("explore", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAgentModelConfigError);
      const typedError = error as MissingAgentModelConfigError;
      expect(typedError.name).toBe("MissingAgentModelConfigError");
      expect(typedError.agentName).toBe("explore");
      expect(typedError.availableAgents).toEqual(["orchestrator"]);
    }
  });

  test("preserves unknown model error name and public fields", () => {
    const config = configWithAgents({ orchestrator: { model: "test:missing" } });

    try {
      resolveAgentModel("orchestrator", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownQualifiedIdError);
      const typedError = error as UnknownQualifiedIdError;
      expect(typedError.name).toBe("UnknownQualifiedIdError");
      expect(typedError.qualifiedId).toBe("test:missing");
      expect(typedError.availableIds).toEqual(["test:main", "test:bare"]);
    }
  });

  test("throws UnknownModelVariantError with agent, model, requested variant, and available variants", () => {
    const config = configWithAgents({
      orchestrator: { model: "test:main", variant: "missing" },
    });

    try {
      resolveAgentModel("orchestrator", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelVariantError);
      const typedError = error as UnknownModelVariantError;
      expect(typedError.name).toBe("UnknownModelVariantError");
      expect(typedError.agentName).toBe("orchestrator");
      expect(typedError.modelId).toBe("test:main");
      expect(typedError.requestedVariant).toBe("missing");
      expect(typedError.availableVariants).toEqual(["fast", "careful"]);
    }
  });

  test("throws UnknownModelVariantError with empty available variants when model has none", () => {
    const config = configWithAgents({
      orchestrator: { model: "test:bare", variant: "missing" },
    });

    try {
      resolveAgentModel("orchestrator", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelVariantError);
      const typedError = error as UnknownModelVariantError;
      expect(typedError.name).toBe("UnknownModelVariantError");
      expect(typedError.agentName).toBe("orchestrator");
      expect(typedError.modelId).toBe("test:bare");
      expect(typedError.requestedVariant).toBe("missing");
      expect(typedError.availableVariants).toEqual([]);
    }
  });

  test("does not include variant in returned options", () => {
    const config = configWithAgents({
      orchestrator: { model: "test:main", variant: "careful" },
    });

    const result = resolveAgentModel("orchestrator", config, makeRegistry(config));

    expect(result.options).toEqual({
      maxOutputTokens: 100,
      temperature: 0.2,
      topK: 40,
      providerOptions: { test: { base: true } },
    });
    expect("variant" in (result.options ?? {})).toBe(false);
  });

  test("returns options as undefined when no options configured", () => {
    const config = configWithAgents({ orchestrator: { model: "test:bare" } });

    const result = resolveAgentModel("orchestrator", config, makeRegistry(config));

    expect(result.options).toBeUndefined();
  });
});
