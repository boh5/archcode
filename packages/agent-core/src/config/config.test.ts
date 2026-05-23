import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  parseConfig,
  loadConfig,
  ConfigLoadError,
  ConfigParseError,
  ConfigValidationError,
  getProviderConfig,
  getModelConfig,
  createProviderInstance,
  createLanguageModel,
  UnsupportedProviderPackageError,
  UnknownProviderError,
  UnknownModelError,
} from "./index";

const VALID_CONFIG = {
  $schema: "http://xxxx/config.json",
  provider: {
    xxx: {
      npm: "@ai-sdk/openai-compatible",
      name: "xxx",
      options: {
        baseURL: "http://localhost:8090/v1",
        apiKey: "test-key",
      },
      models: {
        "gpt-5.2": {
          name: "GPT-5.2",
          limit: { context: 400000, output: 128000 },
          modalities: {
            input: ["text", "image"],
            output: ["text"],
          },
        },
      },
    },
  },
};

describe("parseConfig", () => {
  test("parses a valid config", () => {
    const config = parseConfig(VALID_CONFIG);
    expect(config.provider).toBeDefined();
    expect(config.provider["xxx"].name).toBe("xxx");
    expect(config.provider["xxx"].models["gpt-5.2"].name).toBe("GPT-5.2");
  });

  test("parses config without $schema", () => {
    const { $schema: _, ...noSchema } = VALID_CONFIG;
    const config = parseConfig(noSchema);
    expect(config.provider).toBeDefined();
  });

  test("rejects missing provider key", () => {
    try {
      parseConfig({});
      throw new Error("Expected parseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const typedError = error as ConfigValidationError;
      expect(typedError.name).toBe("ConfigValidationError");
      expect(typedError.filePath).toBe("<inline>");
    }
  });

  test("rejects empty provider object", () => {
    expect(() => parseConfig({ provider: {} })).toThrow(ConfigValidationError);
  });

  test("rejects provider with empty models", () => {
    const config = {
      provider: {
        xxx: {
          npm: "@ai-sdk/openai-compatible",
          name: "xxx",
          options: { baseURL: "http://localhost:8090/v1" },
          models: {},
        },
      },
    };
    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects invalid baseURL", () => {
    const config = {
      provider: {
        xxx: {
          npm: "@ai-sdk/openai-compatible",
          name: "xxx",
          options: { baseURL: "not-a-url" },
          models: {
            "gpt-5.2": {
              name: "GPT-5.2",
              limit: { context: 400000, output: 128000 },
              modalities: { input: ["text"], output: ["text"] },
            },
          },
        },
      },
    };
    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects invalid modality", () => {
    const config = {
      provider: {
        xxx: {
          npm: "@ai-sdk/openai-compatible",
          name: "xxx",
          options: { baseURL: "http://localhost:8090/v1" },
          models: {
            "gpt-5.2": {
              name: "GPT-5.2",
              limit: { context: 400000, output: 128000 },
              modalities: { input: ["telepathy"], output: ["text"] },
            },
          },
        },
      },
    };
    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects unknown top-level keys", () => {
    expect(() =>
      parseConfig({ ...VALID_CONFIG, unknownKey: true }),
    ).toThrow(ConfigValidationError);
  });

  test("parses config with model options", () => {
    const config = {
      ...VALID_CONFIG,
      provider: {
        xxx: {
          ...VALID_CONFIG.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG.provider.xxx.models["gpt-5.2"],
              options: {
                maxOutputTokens: 8192,
                temperature: 0.7,
                topP: 0.9,
                providerOptions: { custom: "value" },
              },
            },
          },
        },
      },
    };
    const parsed = parseConfig(config);
    const model = parsed.provider.xxx.models["gpt-5.2"];
    expect(model.options).toBeDefined();
    expect(model.options!.maxOutputTokens).toBe(8192);
    expect(model.options!.temperature).toBe(0.7);
    expect(model.options!.providerOptions).toEqual({ custom: "value" });
  });

  test("parses every supported model call option key exactly", () => {
    const config = {
      ...VALID_CONFIG,
      provider: {
        xxx: {
          ...VALID_CONFIG.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG.provider.xxx.models["gpt-5.2"],
              options: {
                maxOutputTokens: 8192,
                temperature: 0.7,
                topP: 0.9,
                topK: 50,
                presencePenalty: -0.25,
                frequencyPenalty: 0.5,
                stopSequences: ["</stop>"],
                seed: 123,
                maxRetries: 3,
                timeout: 30_000,
                providerOptions: { custom: { flag: true } },
              },
            },
          },
        },
      },
    };

    const parsed = parseConfig(config);
    const options = parsed.provider.xxx.models["gpt-5.2"].options;

    expect(options).toEqual({
      maxOutputTokens: 8192,
      temperature: 0.7,
      topP: 0.9,
      topK: 50,
      presencePenalty: -0.25,
      frequencyPenalty: 0.5,
      stopSequences: ["</stop>"],
      seed: 123,
      maxRetries: 3,
      timeout: 30_000,
      providerOptions: { custom: { flag: true } },
    });
    expect(options).not.toHaveProperty("variant");
  });

  test("parses config with model variants", () => {
    const config = {
      ...VALID_CONFIG,
      provider: {
        xxx: {
          ...VALID_CONFIG.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG.provider.xxx.models["gpt-5.2"],
              variants: {
                creative: { temperature: 0.9, topP: 0.95 },
                precise: { temperature: 0.1, topP: 0.1 },
              },
            },
          },
        },
      },
    };
    const parsed = parseConfig(config);
    const model = parsed.provider.xxx.models["gpt-5.2"];
    expect(model.variants).toBeDefined();
    expect(model.variants!["creative"].temperature).toBe(0.9);
    expect(model.variants!["precise"].topP).toBe(0.1);
  });

  test("parses config with top-level agents", () => {
    const config = {
      ...VALID_CONFIG,
      agents: {
        orchestrator: {
          model: "xxx:gpt-5.2",
          variant: "creative",
          options: { maxRetries: 3 },
        },
        explore: {
          model: "xxx:gpt-5.2",
          options: { temperature: 0.5 },
        },
      },
    };
    const parsed = parseConfig(config);
    expect(parsed.agents).toBeDefined();
    expect(parsed.agents!["orchestrator"].model).toBe("xxx:gpt-5.2");
    expect(parsed.agents!["orchestrator"].variant).toBe("creative");
    expect(parsed.agents!["orchestrator"].options!.maxRetries).toBe(3);
    expect(parsed.agents!["explore"].model).toBe("xxx:gpt-5.2");
    expect(parsed.agents!["explore"].options!.temperature).toBe(0.5);
  });

  test("memory config is optional", () => {
    const parsed = parseConfig(VALID_CONFIG);

    expect(parsed.memory).toBeUndefined();
  });

  test("memory config applies extraction defaults", () => {
    const parsed = parseConfig({
      ...VALID_CONFIG,
      memory: {},
    });

    expect(parsed.memory).toEqual({
      enabled: true,
      minMessages: 5,
      minContentLength: 1000,
      cooldownMs: 300000,
    });
  });

  test("memory config accepts custom extraction values", () => {
    const parsed = parseConfig({
      ...VALID_CONFIG,
      memory: {
        enabled: false,
        minMessages: 2,
        minContentLength: 250,
        cooldownMs: 0,
      },
    });

    expect(parsed.memory).toEqual({
      enabled: false,
      minMessages: 2,
      minContentLength: 250,
      cooldownMs: 0,
    });
  });

  test("memory config rejects invalid values", () => {
    expect(() => parseConfig({ ...VALID_CONFIG, memory: { minMessages: 0 } })).toThrow(ConfigValidationError);
    expect(() => parseConfig({ ...VALID_CONFIG, memory: { minContentLength: 99 } })).toThrow(ConfigValidationError);
    expect(() => parseConfig({ ...VALID_CONFIG, memory: { cooldownMs: -1 } })).toThrow(ConfigValidationError);
  });

  test("memory config rejects unknown fields", () => {
    expect(() => parseConfig({
      ...VALID_CONFIG,
      memory: { enabled: true, unknown: true },
    })).toThrow(ConfigValidationError);
  });

  test("parses config with unknown agent key (record is open)", () => {
    const config = {
      ...VALID_CONFIG,
      agents: {
        futureAgent: { model: "xxx:gpt-5.2" },
      },
    };
    const parsed = parseConfig(config);
    expect(parsed.agents!["futureAgent"].model).toBe("xxx:gpt-5.2");
  });

  test("rejects unknown option field (e.g. top_p snake_case)", () => {
    const config = {
      ...VALID_CONFIG,
      provider: {
        xxx: {
          ...VALID_CONFIG.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG.provider.xxx.models["gpt-5.2"],
              options: { top_p: 0.9 },
            },
          },
        },
      },
    };
    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects variant key inside model call options", () => {
    const config = {
      ...VALID_CONFIG,
      provider: {
        xxx: {
          ...VALID_CONFIG.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG.provider.xxx.models["gpt-5.2"],
              options: { variant: "fast" },
            },
          },
        },
      },
    };

    try {
      parseConfig(config);
      throw new Error("Expected parseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).name).toBe("ConfigValidationError");
    }
  });

  test("rejects unknown keys within an agent config", () => {
    const config = {
      ...VALID_CONFIG,
      agents: {
        orchestrator: {
          model: "xxx:gpt-5.2",
          unexpected: true,
        },
      },
    };

    try {
      parseConfig(config);
      throw new Error("Expected parseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).name).toBe("ConfigValidationError");
    }
  });

  test("still parses config without agents/options/variants", () => {
    const parsed = parseConfig(VALID_CONFIG);
    expect(parsed.provider.xxx.models["gpt-5.2"].options).toBeUndefined();
    expect(parsed.provider.xxx.models["gpt-5.2"].variants).toBeUndefined();
    expect((parsed as any).agents).toBeUndefined();
  });
});

describe("loadConfig", () => {
  const tmpDir = join(import.meta.dir, "__test_tmp__");

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("loads a valid config from file", async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "valid.json");
    await Bun.write(filePath, JSON.stringify(VALID_CONFIG));

    const config = await loadConfig(filePath);
    expect(config.provider["xxx"].name).toBe("xxx");
  });

  test("throws ConfigLoadError for missing file", async () => {
    const filePath = join(tmpDir, "nonexistent.json");

    try {
      await loadConfig(filePath);
      throw new Error("Expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigLoadError);
      const typedError = error as ConfigLoadError;
      expect(typedError.name).toBe("ConfigLoadError");
      expect(typedError.filePath).toBe(filePath);
    }
  });

  test("throws ConfigParseError for invalid JSON", async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "bad.json");
    await Bun.write(filePath, "{ not valid json");

    try {
      await loadConfig(filePath);
      throw new Error("Expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigParseError);
      const typedError = error as ConfigParseError;
      expect(typedError.name).toBe("ConfigParseError");
      expect(typedError.filePath).toBe(filePath);
    }
  });

  test("throws ConfigValidationError for invalid schema", async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "invalid.json");
    await Bun.write(filePath, JSON.stringify({ provider: {} }));

    try {
      await loadConfig(filePath);
      throw new Error("Expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const typedError = error as ConfigValidationError;
      expect(typedError.name).toBe("ConfigValidationError");
      expect(typedError.filePath).toBe(filePath);
    }
  });
});

describe("getProviderConfig", () => {
  const providers = parseConfig(VALID_CONFIG).provider;

  test("returns provider by id", () => {
    const provider = getProviderConfig(providers, "xxx");
    expect(provider.name).toBe("xxx");
  });

  test("throws UnknownProviderError for unknown id", () => {
    try {
      getProviderConfig(providers, "nonexistent");
      throw new Error("Expected getProviderConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownProviderError);
      const typedError = error as UnknownProviderError;
      expect(typedError.name).toBe("UnknownProviderError");
      expect(typedError.providerId).toBe("nonexistent");
      expect(typedError.availableIds).toEqual(["xxx"]);
    }
  });
});

describe("getModelConfig", () => {
  const provider = parseConfig(VALID_CONFIG).provider["xxx"];

  test("returns model by id", () => {
    const model = getModelConfig(provider, "gpt-5.2");
    expect(model.name).toBe("GPT-5.2");
  });

  test("throws UnknownModelError for unknown model", () => {
    try {
      getModelConfig(provider, "nonexistent");
      throw new Error("Expected getModelConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelError);
      const typedError = error as UnknownModelError;
      expect(typedError.name).toBe("UnknownModelError");
      expect(typedError.modelId).toBe("nonexistent");
      expect(typedError.providerId).toBe("xxx");
      expect(typedError.availableIds).toEqual(["gpt-5.2"]);
    }
  });
});

describe("createProviderInstance", () => {
  test("creates an instance for a valid provider", () => {
    const provider = parseConfig(VALID_CONFIG).provider["xxx"];
    const instance = createProviderInstance(provider);
    expect(instance).toBeDefined();
    expect(typeof instance.chatModel).toBe("function");
  });

  test("throws UnsupportedProviderPackageError for unknown npm", () => {
    const provider = parseConfig(VALID_CONFIG).provider["xxx"];
    const modified = { ...provider, npm: "@ai-sdk/unknown" };
    expect(() => createProviderInstance(modified)).toThrow(
      UnsupportedProviderPackageError,
    );
  });
});

describe("createLanguageModel", () => {
  test("creates a language model from config + ids", () => {
    const providers = parseConfig(VALID_CONFIG).provider;
    const model = createLanguageModel(providers, "xxx", "gpt-5.2");
    expect(model).toBeDefined();
    expect(typeof model.doGenerate).toBe("function");
  });
});
