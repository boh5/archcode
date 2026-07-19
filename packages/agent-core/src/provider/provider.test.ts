import { describe, expect, test } from "bun:test";
import { parseConfig } from "../config/index";
import {
  createRegistry,
  ProviderRegistry,
  ModelInfo,
  UnknownQualifiedIdError,
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
        "gpt-4o-mini": {
          name: "GPT-4o Mini",
          limit: { context: 128000, output: 16384 },
          modalities: {
            input: ["text"],
            output: ["text"],
          },
        },
      },
    },
    yyy: {
      npm: "@ai-sdk/openai-compatible",
      name: "yyy",
      options: {
        baseURL: "http://localhost:9090/v1",
      },
      models: {
        "claude-4": {
          name: "Claude 4",
          limit: { context: 200000, output: 64000 },
          modalities: {
            input: ["text", "image"],
            output: ["text"],
          },
        },
      },
    },
  },
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

describe("createRegistry", () => {
  const providers = parseConfig(VALID_CONFIG).provider;
  const registry = createRegistry(providers);

  test("returns a ProviderRegistry instance", () => {
    expect(registry).toBeInstanceOf(ProviderRegistry);
  });

  test("has sdkRegistry with languageModel method", () => {
    expect(typeof registry.sdkRegistry.languageModel).toBe("function");
  });

  test("indexes all provider models", () => {
    expect(registry.models.size).toBe(3);
    expect(registry.modelIds).toEqual(
      expect.arrayContaining(["xxx:gpt-5.2", "xxx:gpt-4o-mini", "yyy:claude-4"]),
    );
  });
});

describe("Registry.getModel", () => {
  const providers = parseConfig(VALID_CONFIG).provider;
  const registry = createRegistry(providers);

  test("returns ModelInfo for a valid qualified id", () => {
    const info = registry.getModel("xxx:gpt-5.2");
    expect(info).toBeInstanceOf(ModelInfo);
    expect(info.displayName).toBe("GPT-5.2");
    expect(info.providerId).toBe("xxx");
    expect(info.modelId).toBe("gpt-5.2");
    expect(info.qualifiedId).toBe("xxx:gpt-5.2");
  });

  test("returns correct metadata for different providers", () => {
    const claude = registry.getModel("yyy:claude-4");
    expect(claude.displayName).toBe("Claude 4");
    expect(claude.providerId).toBe("yyy");
    expect(claude.limit.context).toBe(200000);
    expect(claude.limit.output).toBe(64000);
    expect(claude.modalities.input).toEqual(["text", "image"]);
    expect(claude.modalities.output).toEqual(["text"]);
  });

  test("throws UnknownQualifiedIdError for unknown model", () => {
    expect(() => registry.getModel("xxx:nonexistent")).toThrow(
      UnknownQualifiedIdError,
    );
  });

  test("throws UnknownQualifiedIdError for unknown provider", () => {
    expect(() => registry.getModel("zzz:model")).toThrow(
      UnknownQualifiedIdError,
    );
  });

  test("error includes available ids", () => {
    try {
      registry.getModel("nope:nope");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownQualifiedIdError);
      const e = err as UnknownQualifiedIdError;
      expect(e.qualifiedId).toBe("nope:nope");
      expect(e.availableIds.length).toBe(3);
    }
  });
});

describe("ModelInfo", () => {
  const providers = parseConfig(VALID_CONFIG).provider;
  const registry = createRegistry(providers);
  const info = registry.getModel("xxx:gpt-5.2");

  test("has a usable AI SDK model", () => {
    expect(info.model).toBeDefined();
    expect(typeof info.model.doGenerate).toBe("function");
  });

  test("exposes limit metadata", () => {
    expect(info.limit).toEqual({ context: 400000, output: 128000 });
  });

  test("exposes modalities", () => {
    expect(info.modalities.input).toEqual(["text", "image"]);
    expect(info.modalities.output).toEqual(["text"]);
  });

  test("qualifiedId is providerId:modelId", () => {
    expect(info.qualifiedId).toBe("xxx:gpt-5.2");
  });

  test("keeps metadata immutable when source config or consumers mutate", () => {
    const source = parseConfig(VALID_CONFIG).provider;
    const immutable = createRegistry(source).getModel("xxx:gpt-5.2");
    source.xxx.models["gpt-5.2"]!.limit.context = 1;

    expect(immutable.limit.context).toBe(400000);
    expect(() => { (immutable as { displayName: string }).displayName = "Changed"; }).toThrow();
    expect(() => { (immutable.limit as { context: number }).context = 1; }).toThrow();
    expect(() => { (immutable.modalities.input as string[]).push("audio"); }).toThrow();
  });
});
