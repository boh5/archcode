import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
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
} from "./index.js";

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
    expect(() => parseConfig({})).toThrow(ConfigValidationError);
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
});

describe("loadConfig", () => {
  const tmpDir = join(import.meta.dirname, "__test_tmp__");

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("loads a valid config from file", async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "valid.json");
    await writeFile(filePath, JSON.stringify(VALID_CONFIG), "utf-8");

    const config = await loadConfig(filePath);
    expect(config.provider["xxx"].name).toBe("xxx");
  });

  test("throws ConfigLoadError for missing file", async () => {
    expect(
      loadConfig(join(tmpDir, "nonexistent.json")),
    ).rejects.toThrow(ConfigLoadError);
  });

  test("throws ConfigParseError for invalid JSON", async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "bad.json");
    await writeFile(filePath, "{ not valid json", "utf-8");

    expect(loadConfig(filePath)).rejects.toThrow(ConfigParseError);
  });

  test("throws ConfigValidationError for invalid schema", async () => {
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "invalid.json");
    await writeFile(filePath, JSON.stringify({ provider: {} }), "utf-8");

    expect(loadConfig(filePath)).rejects.toThrow(ConfigValidationError);
  });
});

describe("getProviderConfig", () => {
  const providers = parseConfig(VALID_CONFIG).provider;

  test("returns provider by id", () => {
    const provider = getProviderConfig(providers, "xxx");
    expect(provider.name).toBe("xxx");
  });

  test("throws UnknownProviderError for unknown id", () => {
    expect(() => getProviderConfig(providers, "nonexistent")).toThrow(
      UnknownProviderError,
    );
  });
});

describe("getModelConfig", () => {
  const provider = parseConfig(VALID_CONFIG).provider["xxx"];

  test("returns model by id", () => {
    const model = getModelConfig(provider, "gpt-5.2");
    expect(model.name).toBe("GPT-5.2");
  });

  test("throws UnknownModelError for unknown model", () => {
    expect(() => getModelConfig(provider, "nonexistent")).toThrow(
      UnknownModelError,
    );
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
