import { describe, expect, test } from "bun:test";
import type { ArchCodeConfig } from "../config/index";
import { ModelInfo, type Registry as ProviderRegistry } from "../provider/index";
import { resolveAgentModel } from "./model-resolver";

const baseModel = {
  name: "Main Model",
  limit: { context: 1000, output: 100 },
  modalities: { input: ["text"], output: ["text"] },
} satisfies ArchCodeConfig["provider"][string]["models"][string];

function makeConfig(
  model: ArchCodeConfig["provider"][string]["models"][string],
  agent: NonNullable<ArchCodeConfig["agents"]>[string],
): ArchCodeConfig {
  return {
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        name: "test",
        options: { baseURL: "http://localhost:8090/v1" },
        models: { main: model },
      },
    },
    agents: { orchestrator: agent },
  };
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
      if (!info) throw new Error(`Unknown model: ${qualifiedId}`);
      return info;
    },
  } as ProviderRegistry;
}

function resolve(config: ArchCodeConfig) {
  return resolveAgentModel("orchestrator", config, makeRegistry(config)).options;
}

describe("resolveAgentModel merge order", () => {
  test("returns exact model.options when only model options are configured", () => {
    const config = makeConfig(
      {
        ...baseModel,
        options: {
          maxOutputTokens: 100,
          temperature: 0.2,
          topP: 0.8,
          providerOptions: { model: { layer: "base" } },
        },
      },
      { model: "test:main" },
    );

    const options = resolve(config);

    expect(options).toEqual({
      maxOutputTokens: 100,
      temperature: 0.2,
      topP: 0.8,
      providerOptions: { model: { layer: "base" } },
    });
    expect(Object.keys(options ?? {}).sort()).toEqual([
      "maxOutputTokens",
      "providerOptions",
      "temperature",
      "topP",
    ]);
    expect(options).not.toHaveProperty("variant");
  });

  test("returns exact variant options when only a variant is selected", () => {
    const config = makeConfig(
      {
        ...baseModel,
        variants: {
          fast: {
            temperature: 0.7,
            topK: 40,
            providerOptions: { variant: { layer: "fast" } },
          },
        },
      },
      { model: "test:main", variant: "fast" },
    );

    const options = resolve(config);

    expect(options).toEqual({
      temperature: 0.7,
      topK: 40,
      providerOptions: { variant: { layer: "fast" } },
    });
    expect(Object.keys(options ?? {}).sort()).toEqual([
      "providerOptions",
      "temperature",
      "topK",
    ]);
    expect(options).not.toHaveProperty("variant");
  });

  test("returns exact agent.options when only agent options are configured", () => {
    const config = makeConfig(
      baseModel,
      {
        model: "test:main",
        options: {
          maxRetries: 2,
          timeout: 5000,
          providerOptions: { agent: { layer: "override" } },
        },
      },
    );

    const options = resolve(config);

    expect(options).toEqual({
      maxRetries: 2,
      timeout: 5000,
      providerOptions: { agent: { layer: "override" } },
    });
    expect(Object.keys(options ?? {}).sort()).toEqual([
      "maxRetries",
      "providerOptions",
      "timeout",
    ]);
    expect(options).not.toHaveProperty("variant");
  });

  test("merges model.options, variant, and agent.options with later layers winning", () => {
    const config = makeConfig(
      {
        ...baseModel,
        options: {
          maxOutputTokens: 100,
          temperature: 0.2,
          topP: 0.8,
          seed: 1,
          providerOptions: { model: { a: 1 } },
        },
        variants: {
          fast: {
            temperature: 0.7,
            topK: 40,
            seed: 2,
            providerOptions: { variant: { b: 2 } },
          },
        },
      },
      {
        model: "test:main",
        variant: "fast",
        options: {
          temperature: 1.1,
          maxRetries: 3,
          seed: 3,
          providerOptions: { agent: { c: 3 } },
        },
      },
    );

    const options = resolve(config);

    expect(options).toEqual({
      maxOutputTokens: 100,
      temperature: 1.1,
      topP: 0.8,
      topK: 40,
      seed: 3,
      maxRetries: 3,
      providerOptions: { agent: { c: 3 } },
    });
    expect(Object.keys(options ?? {}).sort()).toEqual([
      "maxOutputTokens",
      "maxRetries",
      "providerOptions",
      "seed",
      "temperature",
      "topK",
      "topP",
    ]);
    expect(options).not.toHaveProperty("variant");
  });

  test("shallow-replaces providerOptions instead of deep-merging providerOptions keys", () => {
    const config = makeConfig(
      {
        ...baseModel,
        options: {
          temperature: 0.2,
          providerOptions: { a: 1, b: 2 },
        },
      },
      {
        model: "test:main",
        options: {
          providerOptions: { c: 3 },
        },
      },
    );

    const options = resolve(config);

    expect(options).toEqual({
      temperature: 0.2,
      providerOptions: { c: 3 },
    });
    expect(options?.providerOptions).toEqual({ c: 3 });
    expect(options?.providerOptions).not.toEqual({ a: 1, b: 2, c: 3 });
    expect(options).not.toHaveProperty("variant");
  });
});
