import { describe, expect, test } from "bun:test";
import {
  MissingProviderOptionError,
  UnsupportedProviderOptionError,
  ProviderAdapterCatalog,
  providerAdapterCatalog,
} from "./provider-adapter-catalog";

const packageNames = [
  "@ai-sdk/alibaba",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/anthropic",
  "@ai-sdk/azure",
  "@ai-sdk/baseten",
  "@ai-sdk/cerebras",
  "@ai-sdk/cohere",
  "@ai-sdk/deepinfra",
  "@ai-sdk/deepseek",
  "@ai-sdk/fireworks",
  "@ai-sdk/gateway",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/groq",
  "@ai-sdk/huggingface",
  "@ai-sdk/mistral",
  "@ai-sdk/moonshotai",
  "@ai-sdk/open-responses",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/perplexity",
  "@ai-sdk/togetherai",
  "@ai-sdk/vercel",
  "@ai-sdk/xai",
] as const;

function optionsFor(npmPackage: string): Record<string, unknown> {
  if (npmPackage === "@ai-sdk/open-responses") {
    return { url: "https://responses.example.test/v1", apiKey: "test-key" };
  }

  if (npmPackage === "@ai-sdk/openai-compatible") {
    return { baseURL: "https://compatible.example.test/v1", apiKey: "test-key" };
  }

  if (npmPackage === "@ai-sdk/amazon-bedrock") {
    return {
      region: "us-east-1",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    };
  }

  if (npmPackage === "@ai-sdk/google-vertex") {
    return { project: "test-project", location: "us-central1", apiKey: "test-key" };
  }

  return { apiKey: "test-key", baseURL: "https://provider.example.test/v1" };
}

describe("ProviderAdapterCatalog", () => {
  test("contains the complete supported provider package set", () => {
    expect(providerAdapterCatalog.list().map((adapter) => adapter.npmPackage).sort()).toEqual(
      [...packageNames].sort(),
    );
  });

  test("creates a ProviderV3 language model for every catalog adapter", () => {
    for (const npmPackage of packageNames) {
      const adapter = providerAdapterCatalog.get(npmPackage);
      expect(adapter).toBeDefined();

      const provider = adapter!.create({
        providerId: "stable-namespace",
        options: optionsFor(npmPackage),
      });
      const model = provider.languageModel("test-model");

      expect(provider).toHaveProperty("languageModel");
      expect(typeof model.doGenerate).toBe("function");
    }
  });

  test("round-trips common and Advanced JSON options into every adapter factory input", () => {
    for (const npmPackage of packageNames) {
      const adapter = providerAdapterCatalog.get(npmPackage)!;
      const required = optionsFor(npmPackage);
      const options = {
        ...required,
        headers: { "x-test-header": "header-value" },
        ...(npmPackage === "@ai-sdk/openai-compatible"
          ? { queryParams: { trace: "query-value" } }
          : {}),
        advancedFeature: {
          enabled: true,
          retries: [1, 2, 3],
          metadata: { region: "test" },
        },
      };

      expect(adapter.factoryInput({ providerId: "stable-namespace", options })).toEqual({
        ...options,
        ...([
          "@ai-sdk/open-responses",
          "@ai-sdk/openai-compatible",
        ].includes(npmPackage) ? { name: "stable-namespace" } : {}),
      });

      expect(() => adapter.create({
        providerId: "stable-namespace",
        options,
      }).languageModel("test-model")).not.toThrow();
    }
  });

  test("uses the stable provider ID as the namespace for compatible adapters", () => {
    for (const npmPackage of [
      "@ai-sdk/open-responses",
      "@ai-sdk/openai-compatible",
    ]) {
      const adapter = providerAdapterCatalog.get(npmPackage)!;
      const model = adapter
        .create({
          providerId: "stable-namespace",
          options: optionsFor(npmPackage),
        })
        .languageModel("test-model");

      expect(model.provider).toStartWith("stable-namespace");
    }
  });

  test("rejects missing required factory options before invoking adapters", () => {
    for (const npmPackage of [
      "@ai-sdk/open-responses",
      "@ai-sdk/openai-compatible",
    ]) {
      const adapter = providerAdapterCatalog.get(npmPackage)!;
      expect(() =>
        adapter.create({ providerId: "stable-namespace", options: {} }),
      ).toThrow(MissingProviderOptionError);
    }
  });

  test("exposes and accepts queryParams only for OpenAI-compatible", () => {
    for (const adapter of providerAdapterCatalog.list()) {
      const supportsQueryParams = adapter.npmPackage === "@ai-sdk/openai-compatible";
      expect(adapter.optionFields.some((field) => field.path === "queryParams")).toBe(supportsQueryParams);
      expect(adapter.secretPaths.includes("queryParams.*")).toBe(supportsQueryParams);

      const create = () => adapter.create({
        providerId: "stable-namespace",
        options: { ...optionsFor(adapter.npmPackage), queryParams: { trace: "query-value" } },
      });
      if (supportsQueryParams) expect(create).not.toThrow();
      else expect(create).toThrow(UnsupportedProviderOptionError);
    }
  });

  test("rejects Advanced name when the Provider namespace owns that factory field", () => {
    for (const npmPackage of ["@ai-sdk/open-responses", "@ai-sdk/openai-compatible"] as const) {
      const adapter = providerAdapterCatalog.get(npmPackage)!;
      expect(() => adapter.create({
        providerId: "stable-namespace",
        options: { ...optionsFor(npmPackage), name: "shadow-namespace" },
      })).toThrow(UnsupportedProviderOptionError);
    }
  });

  test("protects catalog construction from duplicate package entries", () => {
    const source = providerAdapterCatalog.list()[0]!;
    const adapter = {
      npmPackage: source.npmPackage,
      displayName: source.displayName,
      optionFields: source.optionFields,
      secretPaths: source.secretPaths,
      createFromFactoryInput: () => { throw new Error("must not create"); },
    };
    expect(() => new ProviderAdapterCatalog([adapter, adapter])).toThrow(
      'Duplicate provider adapter package: "@ai-sdk/gateway".',
    );
  });

  test("marks supported transport credential fields as secrets", () => {
    for (const adapter of providerAdapterCatalog.list()) {
      expect(adapter.optionFields.some((field) => field.path === "headers")).toBeTrue();
      expect(adapter.secretPaths).toContain("headers.*");
      for (const secretPath of adapter.secretPaths) {
        const fieldPath = secretPath.endsWith(".*") ? secretPath.slice(0, -2) : secretPath;
        expect(adapter.optionFields.some((field) => field.path === fieldPath)).toBeTrue();
      }
    }
    for (const adapter of providerAdapterCatalog.toDto()) {
      expect(adapter.fields).toContainEqual(
        expect.objectContaining({ path: "headers", secret: true }),
      );
      expect(adapter.fields.some((field) => field.path === "queryParams"))
        .toBe(adapter.npmPackage === "@ai-sdk/openai-compatible");
    }
  });

  test("exposes only secret-free adapter metadata", () => {
    const compatible = providerAdapterCatalog.toDto().find(
      (adapter) => adapter.npmPackage === "@ai-sdk/openai-compatible",
    )!;

    expect(compatible.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "baseURL", required: true, secret: false }),
      expect.objectContaining({ path: "apiKey", secret: true }),
      expect.objectContaining({ path: "headers", secret: true }),
      expect.objectContaining({ path: "queryParams", secret: true }),
    ]));
    expect(JSON.stringify(compatible)).not.toContain("test-key");
  });
});
