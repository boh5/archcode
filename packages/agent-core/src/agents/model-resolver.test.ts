import { describe, expect, test } from "bun:test";
import type { ArchCodeConfig } from "../config/index";
import { ModelInfo, UnknownQualifiedIdError, type ProviderRegistry } from "../provider/index";
import { MissingAgentModelConfigError, UnknownModelVariantError } from "./errors";
import { resolveAgentModel } from "./model-resolver";

const baseConfig: ArchCodeConfig = {
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
    engineer: { model: "test:main" },
    goal_lead: { model: "test:main" },
    plan: { model: "test:main" },
    build: { model: "test:main" },
    reviewer: { model: "test:main" },
    explore: { model: "test:main" },
    librarian: { model: "test:main" },
  },
};

function configWithAgents(agents: Record<string, { model: string; variant?: string; options?: Record<string, unknown> }>): ArchCodeConfig {
  return { ...baseConfig, agents: agents as unknown as ArchCodeConfig["agents"] };
}

function makeRegistry(config: ArchCodeConfig): ProviderRegistry {
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

describe("resolveAgentModel", () => {
  test("returns correct ModelInfo for configured agent model", () => {
    const registry = makeRegistry(baseConfig);

    const result = resolveAgentModel("engineer", baseConfig, registry);

    expect(result.modelInfo).toBe(registry.getModel("test:main"));
    expect(result.modelInfo.qualifiedId).toBe("test:main");
  });

  test("merges model options, selected variant, and agent options in order", () => {
    const config = configWithAgents({
      engineer: {
        model: "test:main",
        variant: "fast",
        options: { temperature: 1.1 },
      },
    });

    const result = resolveAgentModel("engineer", config, makeRegistry(config));

    expect(result.options).toEqual({
      maxOutputTokens: 100,
      temperature: 1.1,
      topP: 0.9,
      providerOptions: { test: { variant: true } },
    });
  });

  test("shallow-replaces providerOptions at each layer", () => {
    const config = configWithAgents({
      engineer: {
        model: "test:main",
        variant: "fast",
        options: { providerOptions: { test: { agent: true } } },
      },
    });

    const result = resolveAgentModel("engineer", config, makeRegistry(config));

    expect(result.options?.providerOptions).toEqual({ test: { agent: true } });
  });

  test("throws MissingAgentModelConfigError with agent name and available agents", () => {
    const config = configWithAgents({ explorer: { model: "test:main" } });

    try {
      resolveAgentModel("engineer", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAgentModelConfigError);
      const typedError = error as MissingAgentModelConfigError;
      expect(typedError.name).toBe("MissingAgentModelConfigError");
      expect(typedError.agentName).toBe("engineer");
      expect(typedError.availableAgents).toEqual(["explorer"]);
    }
  });

  test("throws MissingAgentModelConfigError for missing explore model config", () => {
    const config = configWithAgents({ engineer: { model: "test:main" } });

    try {
      resolveAgentModel("explore", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAgentModelConfigError);
      const typedError = error as MissingAgentModelConfigError;
      expect(typedError.name).toBe("MissingAgentModelConfigError");
      expect(typedError.agentName).toBe("explore");
      expect(typedError.availableAgents).toEqual(["engineer"]);
    }
  });

  test("preserves unknown model error name and public fields", () => {
    const config = configWithAgents({ engineer: { model: "test:missing" } });

    try {
      resolveAgentModel("engineer", config, makeRegistry(config));
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
      engineer: { model: "test:main", variant: "missing" },
    });

    try {
      resolveAgentModel("engineer", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelVariantError);
      const typedError = error as UnknownModelVariantError;
      expect(typedError.name).toBe("UnknownModelVariantError");
      expect(typedError.agentName).toBe("engineer");
      expect(typedError.modelId).toBe("test:main");
      expect(typedError.requestedVariant).toBe("missing");
      expect(typedError.availableVariants).toEqual(["fast", "careful"]);
    }
  });

  test("throws UnknownModelVariantError with empty available variants when model has none", () => {
    const config = configWithAgents({
      engineer: { model: "test:bare", variant: "missing" },
    });

    try {
      resolveAgentModel("engineer", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelVariantError);
      const typedError = error as UnknownModelVariantError;
      expect(typedError.name).toBe("UnknownModelVariantError");
      expect(typedError.agentName).toBe("engineer");
      expect(typedError.modelId).toBe("test:bare");
      expect(typedError.requestedVariant).toBe("missing");
      expect(typedError.availableVariants).toEqual([]);
    }
  });

  test("does not include variant in returned options", () => {
    const config = configWithAgents({
      engineer: { model: "test:main", variant: "careful" },
    });

    const result = resolveAgentModel("engineer", config, makeRegistry(config));

    expect(result.options).toEqual({
      maxOutputTokens: 100,
      temperature: 0.2,
      topK: 40,
      providerOptions: { test: { base: true } },
    });
    expect("variant" in (result.options ?? {})).toBe(false);
  });

  test("returns options as undefined when no options configured", () => {
    const config = configWithAgents({ engineer: { model: "test:bare" } });

    const result = resolveAgentModel("engineer", config, makeRegistry(config));

    expect(result.options).toBeUndefined();
  });
});

describe("workflow agent model resolution", () => {
  const workflowAgentNames = ["product", "spec", "critic", "foreman", "builder", "reviewer", "librarian"];

  test("each resolves a model when properly configured", () => {
    const agents: Record<string, { model: string }> = {};
    for (const name of workflowAgentNames) {
      agents[name] = { model: "test:main" };
    }
    const config = configWithAgents(agents);
    const registry = makeRegistry(config);

    for (const name of workflowAgentNames) {
      const result = resolveAgentModel(name, config, registry);
      expect(result.modelInfo.qualifiedId).toBe("test:main");
      expect(result.modelInfo.displayName).toBe("Main Model");
    }
  });

  test("each throws MissingAgentModelConfigError when no agents config entry exists", () => {
    const config = configWithAgents({ engineer: { model: "test:main" } });
    const registry = makeRegistry(config);

    for (const name of workflowAgentNames) {
      try {
        resolveAgentModel(name, config, registry);
        throw new Error(`Expected MissingAgentModelConfigError for "${name}"`);
      } catch (error) {
        expect(error).toBeInstanceOf(MissingAgentModelConfigError);
        const typedError = error as MissingAgentModelConfigError;
        expect(typedError.name).toBe("MissingAgentModelConfigError");
        expect(typedError.agentName).toBe(name);
        expect(typedError.availableAgents).toEqual(["engineer"]);
      }
    }
  });

  test("each throws MissingAgentModelConfigError when model field is empty string", () => {
    const config = configWithAgents({ critic: { model: "" } });
    const registry = makeRegistry(config);

    try {
      resolveAgentModel("critic", config, registry);
      throw new Error("Expected MissingAgentModelConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAgentModelConfigError);
      expect((error as MissingAgentModelConfigError).agentName).toBe("critic");
    }
  });

  test("critic follows shallow merge behavior with variant and agent options", () => {
    const config = configWithAgents({
      critic: {
        model: "test:main",
        variant: "fast",
        options: { temperature: 1.1 },
      },
    });

    const result = resolveAgentModel("critic", config, makeRegistry(config));

    expect(result.options).toEqual({
      maxOutputTokens: 100,
      temperature: 1.1,
      topP: 0.9,
      providerOptions: { test: { variant: true } },
    });
  });

  test("shallow-replaces providerOptions for builder agent name", () => {
    const config = configWithAgents({
      builder: {
        model: "test:main",
        variant: "fast",
        options: { providerOptions: { test: { agent: true } } },
      },
    });

    const result = resolveAgentModel("builder", config, makeRegistry(config));

    expect(result.options?.providerOptions).toEqual({ test: { agent: true } });
  });

  test("unknown model ID throws UnknownQualifiedIdError for workflow agents", () => {
    const config = configWithAgents({ critic: { model: "nonexistent:model" } });

    try {
      resolveAgentModel("critic", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownQualifiedIdError);
      const typedError = error as UnknownQualifiedIdError;
      expect(typedError.name).toBe("UnknownQualifiedIdError");
      expect(typedError.qualifiedId).toBe("nonexistent:model");
    }
  });

  test("unknown variant throws UnknownModelVariantError for workflow agents", () => {
    const config = configWithAgents({
      reviewer: { model: "test:main", variant: "bogus" },
    });

    try {
      resolveAgentModel("reviewer", config, makeRegistry(config));
      throw new Error("Expected resolveAgentModel to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelVariantError);
      const typedError = error as UnknownModelVariantError;
      expect(typedError.name).toBe("UnknownModelVariantError");
      expect(typedError.agentName).toBe("reviewer");
      expect(typedError.modelId).toBe("test:main");
      expect(typedError.requestedVariant).toBe("bogus");
      expect(typedError.availableVariants).toEqual(["fast", "careful"]);
    }
  });

  test("returns options as undefined when bare model configured for librarian", () => {
    const config = configWithAgents({ librarian: { model: "test:bare" } });

    const result = resolveAgentModel("librarian", config, makeRegistry(config));

    expect(result.options).toBeUndefined();
  });

  test("foreman resolves without variant when none specified", () => {
    const config = configWithAgents({ foreman: { model: "test:main" } });

    const result = resolveAgentModel("foreman", config, makeRegistry(config));

    expect(result.modelInfo.qualifiedId).toBe("test:main");
    expect(result.options).toEqual({
      maxOutputTokens: 100,
      temperature: 0.2,
      providerOptions: { test: { base: true } },
    });
  });
});
