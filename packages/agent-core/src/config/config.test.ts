import { describe, expect, test } from "bun:test";
import {
  parseConfig,
  ConfigValidationError,
  getProviderConfig,
  getModelConfig,
  createProviderInstance,
  findSecretBearingProviderOptionPaths,
  UnsupportedProviderPackageError,
  UnknownProviderError,
  UnknownModelError,
  GithubIntegrationTokenError,
  resolveGithubIntegrationConfig,
} from "./index";

const VALID_CONFIG = {
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

const VALID_CONFIG_WITH_AGENTS = {
  ...VALID_CONFIG,
  agents: {
    engineer: { model: "xxx:gpt-5.2" },
    goal_lead: { model: "xxx:gpt-5.2" },
    plan: { model: "xxx:gpt-5.2" },
    build: { model: "xxx:gpt-5.2" },
    reviewer: { model: "xxx:gpt-5.2" },
    explore: { model: "xxx:gpt-5.2" },
    librarian: { model: "xxx:gpt-5.2" },
    shaper: { model: "xxx:gpt-5.2" },
  },
};

describe("parseConfig", () => {
  test("parses a valid config with all 8 required agents", () => {
    const config = parseConfig(VALID_CONFIG_WITH_AGENTS);
    expect(config.provider).toBeDefined();
    expect(config.provider["xxx"].name).toBe("xxx");
    expect(config.provider["xxx"].models["gpt-5.2"].name).toBe("GPT-5.2");
    expect(config.agents).toBeDefined();
    expect(config.agents.engineer.model).toBe("xxx:gpt-5.2");
    expect(config.agents.goal_lead.model).toBe("xxx:gpt-5.2");
    expect(config.agents.plan.model).toBe("xxx:gpt-5.2");
    expect(config.agents.build.model).toBe("xxx:gpt-5.2");
    expect(config.agents.reviewer.model).toBe("xxx:gpt-5.2");
    expect(config.agents.explore.model).toBe("xxx:gpt-5.2");
    expect(config.agents.librarian.model).toBe("xxx:gpt-5.2");
    expect(config.agents.shaper.model).toBe("xxx:gpt-5.2");
  });

  test("rejects the removed $schema field", () => {
    expect(() => parseConfig({ ...VALID_CONFIG_WITH_AGENTS, $schema: "http://xxxx/config.json" })).toThrow(ConfigValidationError);
  });

  test("keeps provider credential expressions literal", () => {
    const value = structuredClone(VALID_CONFIG_WITH_AGENTS);
    value.provider.xxx.options.apiKey = "${PROVIDER_API_KEY:-literal}";

    const config = parseConfig(value);

    expect(config.provider.xxx.options.apiKey).toBe("${PROVIDER_API_KEY:-literal}");
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
      ...VALID_CONFIG_WITH_AGENTS,
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

  test("preserves adapter-specific provider options", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      provider: {
        xxx: {
          npm: "@ai-sdk/openai-compatible",
          name: "xxx",
          options: {
            endpointName: "not-a-url",
            nested: { retry: { enabled: true } },
          },
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
    const parsed = parseConfig(config);
    expect(parsed.provider.xxx.options).toEqual({
      endpointName: "not-a-url",
      nested: { retry: { enabled: true } },
    });
  });

  test("rejects non-JSON provider options", () => {
    const config = structuredClone(VALID_CONFIG_WITH_AGENTS);
    (config.provider.xxx.options as Record<string, unknown>).custom = () => undefined;

    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects non-JSON model-call providerOptions", () => {
    const config = structuredClone(VALID_CONFIG_WITH_AGENTS);
    (config.provider.xxx.models["gpt-5.2"] as Record<string, unknown>).options = {
      providerOptions: { custom: () => undefined },
    };

    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects invalid modality", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
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
      parseConfig({ ...VALID_CONFIG_WITH_AGENTS, unknownKey: true }),
    ).toThrow(ConfigValidationError);
  });

  test("parses config with model options", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      provider: {
        xxx: {
          ...VALID_CONFIG_WITH_AGENTS.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG_WITH_AGENTS.provider.xxx.models["gpt-5.2"],
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
      ...VALID_CONFIG_WITH_AGENTS,
      provider: {
        xxx: {
          ...VALID_CONFIG_WITH_AGENTS.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG_WITH_AGENTS.provider.xxx.models["gpt-5.2"],
              options: {
                maxOutputTokens: 8192,
                temperature: 0.7,
                topP: 0.9,
                topK: 50,
                presencePenalty: -0.25,
                frequencyPenalty: 0.5,
                stopSequences: ["</stop>"],
                seed: 123,
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
      timeout: 30_000,
      providerOptions: { custom: { flag: true } },
    });
    expect(options).not.toHaveProperty("variant");
  });

  test("parses config with model variants", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      provider: {
        xxx: {
          ...VALID_CONFIG_WITH_AGENTS.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG_WITH_AGENTS.provider.xxx.models["gpt-5.2"],
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

  test("rejects removed pricing metadata", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      provider: {
        xxx: {
          ...VALID_CONFIG_WITH_AGENTS.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG_WITH_AGENTS.provider.xxx.models["gpt-5.2"],
              pricing: {
                inputUsdPerMillionTokens: 1.25,
                outputUsdPerMillionTokens: 10,
                reasoningUsdPerMillionTokens: 5,
                cachedInputUsdPerMillionTokens: 0.125,
              },
            },
          },
        },
      },
    };

    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects configurable maxRetries in model, variant, and agent options", () => {
    const model = structuredClone(VALID_CONFIG_WITH_AGENTS) as any;
    model.provider.xxx.models["gpt-5.2"].options = { maxRetries: 2 };
    expect(() => parseConfig(model)).toThrow(ConfigValidationError);

    const variant = structuredClone(VALID_CONFIG_WITH_AGENTS) as any;
    variant.provider.xxx.models["gpt-5.2"].variants = { fast: { maxRetries: 2 } };
    expect(() => parseConfig(variant)).toThrow(ConfigValidationError);

    const agent = structuredClone(VALID_CONFIG_WITH_AGENTS) as any;
    agent.agents.engineer.options = { maxRetries: 2 };
    expect(() => parseConfig(agent)).toThrow(ConfigValidationError);
  });

  test("parses config with all 8 agents and per-agent options", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      agents: {
        engineer: {
          model: "xxx:gpt-5.2",
          variant: "creative",
          options: { temperature: 0.3 },
        },
        goal_lead: { model: "xxx:gpt-5.2" },
        plan: { model: "xxx:gpt-5.2" },
        build: { model: "xxx:gpt-5.2" },
        reviewer: { model: "xxx:gpt-5.2" },
        explore: {
          model: "xxx:gpt-5.2",
          options: { temperature: 0.5 },
        },
        librarian: { model: "xxx:gpt-5.2" },
        shaper: { model: "xxx:gpt-5.2" },
      },
    };
    const parsed = parseConfig(config);
    expect(parsed.agents).toBeDefined();
    expect(parsed.agents.engineer.model).toBe("xxx:gpt-5.2");
    expect(parsed.agents.engineer.variant).toBe("creative");
    expect(parsed.agents.engineer.options!.temperature).toBe(0.3);
    expect(parsed.agents.goal_lead.model).toBe("xxx:gpt-5.2");
    expect(parsed.agents.explore.model).toBe("xxx:gpt-5.2");
    expect(parsed.agents.explore.options!.temperature).toBe(0.5);
    expect(parsed.agents.plan.model).toBe("xxx:gpt-5.2");
    expect(parsed.agents.build.model).toBe("xxx:gpt-5.2");
    expect(parsed.agents.reviewer.model).toBe("xxx:gpt-5.2");
    expect(parsed.agents.librarian.model).toBe("xxx:gpt-5.2");
    expect(parsed.agents.shaper.model).toBe("xxx:gpt-5.2");
  });

  test("memory config is optional", () => {
    const parsed = parseConfig(VALID_CONFIG_WITH_AGENTS);

    expect(parsed.memory).toBeUndefined();
  });

  test("memory config applies extraction defaults", () => {
    const parsed = parseConfig({
      ...VALID_CONFIG_WITH_AGENTS,
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
      ...VALID_CONFIG_WITH_AGENTS,
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
    expect(() => parseConfig({ ...VALID_CONFIG_WITH_AGENTS, memory: { minMessages: 0 } })).toThrow(ConfigValidationError);
    expect(() => parseConfig({ ...VALID_CONFIG_WITH_AGENTS, memory: { minContentLength: 99 } })).toThrow(ConfigValidationError);
    expect(() => parseConfig({ ...VALID_CONFIG_WITH_AGENTS, memory: { cooldownMs: -1 } })).toThrow(ConfigValidationError);
  });

  test("memory config rejects unknown fields", () => {
    expect(() => parseConfig({
      ...VALID_CONFIG_WITH_AGENTS,
      memory: { enabled: true, unknown: true },
    })).toThrow(ConfigValidationError);
  });

  test("parses strict github integration config", () => {
    const parsed = parseConfig({
      ...VALID_CONFIG_WITH_AGENTS,
      integrations: {
        github: {
          enabled: true,
          tokenEnv: "ARCHCODE_GITHUB_TOKEN",
          defaultOwner: "test-owner",
          defaultRepo: "test-repo",
        },
      },
    });

    expect(parsed.integrations?.github).toEqual({
      enabled: true,
      tokenEnv: "ARCHCODE_GITHUB_TOKEN",
      defaultOwner: "test-owner",
      defaultRepo: "test-repo",
    });
  });

  test("rejects the removed github apiBaseUrl field", () => {
    expect(() =>
      parseConfig({
        ...VALID_CONFIG_WITH_AGENTS,
        integrations: {
          github: { apiBaseUrl: "https://api.github.com" },
        },
      }),
    ).toThrow(ConfigValidationError);
  });

  test("rejects unknown github integration fields", () => {
    expect(() =>
      parseConfig({
        ...VALID_CONFIG_WITH_AGENTS,
        integrations: {
          github: { enabled: true, clientSecret: "not-supported" },
        },
      }),
    ).toThrow(ConfigValidationError);
  });

  test("rejects config with unknown agent key (strict object)", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      agents: {
        ...VALID_CONFIG_WITH_AGENTS.agents,
        futureAgent: { model: "xxx:gpt-5.2" },
      },
    };
    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects config missing a required agent", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      agents: {
        engineer: { model: "xxx:gpt-5.2" },
        goal_lead: { model: "xxx:gpt-5.2" },
        plan: { model: "xxx:gpt-5.2" },
        build: { model: "xxx:gpt-5.2" },
        // reviewer is missing
        explore: { model: "xxx:gpt-5.2" },
        librarian: { model: "xxx:gpt-5.2" },
        shaper: { model: "xxx:gpt-5.2" },
      },
    };
    try {
      parseConfig(config);
      throw new Error("Expected parseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const message = (error as ConfigValidationError).message;
      expect(message).toContain("reviewer");
    }
  });

  test("rejects config missing required shaper without a model fallback", () => {
    const { shaper: _, ...agents } = VALID_CONFIG_WITH_AGENTS.agents;

    try {
      parseConfig({ ...VALID_CONFIG_WITH_AGENTS, agents });
      throw new Error("Expected parseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain("shaper");
    }
  });

  test("rejects config with extra agent key", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      agents: {
        ...VALID_CONFIG_WITH_AGENTS.agents,
        product: { model: "xxx:gpt-5.2" },
      },
    };
    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects the removed legacy agent key", () => {
    const removedAgentName = ["orches", "trator"].join("");
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      agents: {
        ...VALID_CONFIG_WITH_AGENTS.agents,
        [removedAgentName]: { model: "xxx:gpt-5.2" },
      },
    };
    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });

  test("rejects unknown option field (e.g. top_p snake_case)", () => {
    const config = {
      ...VALID_CONFIG_WITH_AGENTS,
      provider: {
        xxx: {
          ...VALID_CONFIG_WITH_AGENTS.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG_WITH_AGENTS.provider.xxx.models["gpt-5.2"],
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
      ...VALID_CONFIG_WITH_AGENTS,
      provider: {
        xxx: {
          ...VALID_CONFIG_WITH_AGENTS.provider.xxx,
          models: {
            "gpt-5.2": {
              ...VALID_CONFIG_WITH_AGENTS.provider.xxx.models["gpt-5.2"],
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
      ...VALID_CONFIG_WITH_AGENTS,
      agents: {
        ...VALID_CONFIG_WITH_AGENTS.agents,
        engineer: {
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

  test("rejects config without agents (required)", () => {
    const { agents: _, ...noAgents } = VALID_CONFIG_WITH_AGENTS;
    expect(() => parseConfig(noAgents)).toThrow(ConfigValidationError);
  });
});

describe("resolveGithubIntegrationConfig", () => {
  test("keeps github integration disabled when config block is absent", () => {
    expect(resolveGithubIntegrationConfig(undefined, {})).toEqual({
      enabled: false,
    });
  });

  test("defaults github integration to enabled when config block is present", () => {
    try {
      resolveGithubIntegrationConfig({}, {});
      throw new Error("Expected resolveGithubIntegrationConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GithubIntegrationTokenError);
      expect((error as GithubIntegrationTokenError).attemptedEnvNames).toEqual([
        "GITHUB_TOKEN",
        "GH_TOKEN",
      ]);
      expect((error as GithubIntegrationTokenError).message).not.toContain("secret-sentinel");
    }
  });

  test("keeps explicitly disabled github integration from resolving tokens", () => {
    expect(resolveGithubIntegrationConfig({ enabled: false }, {})).toEqual({
      enabled: false,
    });
  });

  test("uses config token env before default GitHub variables", () => {
    const resolved = resolveGithubIntegrationConfig(
      { enabled: true, tokenEnv: "ARCHCODE_GITHUB_TOKEN" },
      {
        ARCHCODE_GITHUB_TOKEN: "configured-token",
        GITHUB_TOKEN: "github-token",
        GH_TOKEN: "gh-token",
      },
    );

    expect(resolved.token).toBe("configured-token");
    expect(resolved.tokenSource).toBe("ARCHCODE_GITHUB_TOKEN");
  });

  test("falls back to GITHUB_TOKEN", () => {
    const resolved = resolveGithubIntegrationConfig(
      { enabled: true },
      { GITHUB_TOKEN: "github-token", GH_TOKEN: "gh-token" },
    );

    expect(resolved.token).toBe("github-token");
    expect(resolved.tokenSource).toBe("GITHUB_TOKEN");
  });

  test("falls back to GH_TOKEN after GITHUB_TOKEN", () => {
    const resolved = resolveGithubIntegrationConfig(
      { enabled: true },
      { GITHUB_TOKEN: "", GH_TOKEN: "gh-token" },
    );

    expect(resolved.token).toBe("gh-token");
    expect(resolved.tokenSource).toBe("GH_TOKEN");
  });

  test("expands tokenEnv references to token values", () => {
    const resolved = resolveGithubIntegrationConfig(
      { enabled: true, tokenEnv: "${ARCHCODE_GITHUB_TOKEN}" },
      { ARCHCODE_GITHUB_TOKEN: "expanded-token" },
    );

    expect(resolved.token).toBe("expanded-token");
    expect(resolved.tokenSource).toBe("integrations.github.tokenEnv");
  });

  test("expands tokenEnv default fallback values", () => {
    const resolved = resolveGithubIntegrationConfig(
      { enabled: true, tokenEnv: "${ARCHCODE_GITHUB_TOKEN:-fallback-token}" },
      {},
    );

    expect(resolved.token).toBe("fallback-token");
    expect(resolved.tokenSource).toBe("integrations.github.tokenEnv");
  });

  test("allows expanded tokenEnv values to name another env variable", () => {
    const resolved = resolveGithubIntegrationConfig(
      { enabled: true, tokenEnv: "${ARCHCODE_TOKEN_ENV_NAME:-FALLBACK_TOKEN_ENV}" },
      { FALLBACK_TOKEN_ENV: "fallback-token" },
    );

    expect(resolved.token).toBe("fallback-token");
    expect(resolved.tokenSource).toBe("FALLBACK_TOKEN_ENV");
  });

  test("throws typed non-secret token errors when enabled token is missing", () => {
    try {
      resolveGithubIntegrationConfig(
        { enabled: true, tokenEnv: "ARCHCODE_GITHUB_TOKEN" },
        {
          ARCHCODE_GITHUB_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_TOKEN: "",
        },
      );
      throw new Error("Expected resolveGithubIntegrationConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GithubIntegrationTokenError);
      expect((error as GithubIntegrationTokenError).name).toBe("GithubIntegrationTokenError");
      expect((error as GithubIntegrationTokenError).attemptedEnvNames).toEqual([
        "ARCHCODE_GITHUB_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
      ]);
      expect((error as GithubIntegrationTokenError).message).not.toContain("secret-sentinel");
    }
  });

  test("parsed empty github block is enabled and requires a token", () => {
    const parsed = parseConfig({
      ...VALID_CONFIG_WITH_AGENTS,
      integrations: { github: {} },
    });

    expect(() => resolveGithubIntegrationConfig(parsed.integrations?.github, {})).toThrow(
      GithubIntegrationTokenError,
    );
  });
});

describe("getProviderConfig", () => {
  const providers = parseConfig(VALID_CONFIG_WITH_AGENTS).provider;

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
  const provider = parseConfig(VALID_CONFIG_WITH_AGENTS).provider["xxx"];

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
    const provider = parseConfig(VALID_CONFIG_WITH_AGENTS).provider["xxx"];
    const instance = createProviderInstance("xxx", provider);
    expect(instance).toBeDefined();
    expect(typeof instance.languageModel).toBe("function");
  });

  test("throws UnsupportedProviderPackageError for unknown npm", () => {
    const provider = parseConfig(VALID_CONFIG_WITH_AGENTS).provider["xxx"];
    const modified = { ...provider, npm: "@ai-sdk/unknown" };
    expect(() => createProviderInstance("xxx", modified)).toThrow(
      UnsupportedProviderPackageError,
    );
  });
});

describe("provider call-option secret protection", () => {
  test("finds secret-bearing nested paths", () => {
    expect(
      findSecretBearingProviderOptionPaths({
        custom: { authorization: "Bearer should-not-be-here" },
        retries: [{ api_key: "also-not-here" }],
      }),
    ).toEqual([
      "providerOptions.custom.authorization",
      "providerOptions.retries[0].api_key",
    ]);
  });

  test("detects credential-bearing compound keys without rejecting endpoint metadata", () => {
    expect(
      findSecretBearingProviderOptionPaths({
        secretValue: "one",
        credentialFile: "two",
        credentialsJson: "three",
        apiKeyValue: "four",
        privateKeyPem: "five",
        tokenValue: "six",
        accessTokenValue: "seven",
        tokenData: "eight",
        tokensJson: "nine",
        accessKeyId: "ten",
        secretAccessKey: "eleven",
        authorizationHeader: "twelve",
        credentialProvider: "thirteen",
        APIKeyValue: "fourteen",
        APIKeyHeader: "fifteen",
        APITokenValue: "sixteen",
        tokenEndpoint: "https://issuer.example/token",
        passwordResetUrl: "https://app.example/reset",
      }),
    ).toEqual([
      "providerOptions.secretValue",
      "providerOptions.credentialFile",
      "providerOptions.credentialsJson",
      "providerOptions.apiKeyValue",
      "providerOptions.privateKeyPem",
      "providerOptions.tokenValue",
      "providerOptions.accessTokenValue",
      "providerOptions.tokenData",
      "providerOptions.tokensJson",
      "providerOptions.accessKeyId",
      "providerOptions.secretAccessKey",
      "providerOptions.authorizationHeader",
      "providerOptions.credentialProvider",
      "providerOptions.APIKeyValue",
      "providerOptions.APIKeyHeader",
      "providerOptions.APITokenValue",
    ]);
  });

  test("rejects secrets in model-call providerOptions", () => {
    const config = {
      ...structuredClone(VALID_CONFIG_WITH_AGENTS),
      provider: {
        xxx: {
          ...structuredClone(VALID_CONFIG_WITH_AGENTS.provider.xxx),
          models: {
            "gpt-5.2": {
              ...structuredClone(VALID_CONFIG_WITH_AGENTS.provider.xxx.models["gpt-5.2"]),
              options: {
                providerOptions: { nested: { token: "secret-sentinel" } },
              },
            },
          },
        },
      },
    };

    expect(() => parseConfig(config)).toThrow(ConfigValidationError);
  });
});
