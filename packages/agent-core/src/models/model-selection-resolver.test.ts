import { describe, expect, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ArchCodeConfig, ModelConfig } from "../config";
import { ModelInfo, ProviderRegistry } from "../provider";
import { InvalidModelRuntimeSnapshotError, ModelRuntimeSnapshot } from "./model-runtime-snapshot";
import { ModelRuntime } from "./model-runtime";
import { ModelSelectionResolver } from "./model-selection-resolver";

function model(name: string, options?: ModelConfig["options"], variants?: ModelConfig["variants"]): ModelConfig {
  return {
    name,
    limit: { context: 100_000, output: 10_000 },
    modalities: { input: ["text"], output: ["text"] },
    options,
    variants,
  };
}

function config(): ArchCodeConfig {
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Provider",
        options: { baseURL: "http://localhost:8090/v1", apiKey: "must-not-enter-catalog" },
        models: {
          alpha: model("Alpha", {
            temperature: 0.1,
            topP: 0.7,
            providerOptions: { local: { layer: "model" } },
          }, {
            deep: {
              temperature: 0.2,
              maxOutputTokens: 8_000,
              providerOptions: { local: { layer: "variant" } },
            },
          }),
          beta: model("Beta", { temperature: 0.4, presencePenalty: 0.5 }, {
            fast: { maxOutputTokens: 2_000 },
          }),
        },
      },
      remote: {
        npm: "@ai-sdk/openai-compatible",
        name: "Remote Provider",
        options: { baseURL: "https://example.test/v1", apiKey: "remote-secret" },
        models: { gamma: model("Gamma", { frequencyPenalty: 0.4 }) },
      },
    },
    profiles: {
      principal: {
        model: "local:alpha",
        variant: "deep",
        options: {
          temperature: 0.3,
          topK: 4,
          providerOptions: { local: { layer: "profile" } },
        },
      },
      deep: { model: "local:alpha", variant: "deep", options: { temperature: 0.25 } },
      fast: { model: "local:beta", variant: "fast", options: { temperature: 0.05 } },
    },
  };
}

function registry(value: ArchCodeConfig): ProviderRegistry {
  const models = new Map<string, ModelInfo>();
  for (const [providerId, provider] of Object.entries(value.provider)) {
    for (const [modelId, modelConfig] of Object.entries(provider.models)) {
      const info = new ModelInfo({ model: {} as LanguageModelV3, config: modelConfig, providerId, modelId });
      models.set(info.qualifiedId, info);
    }
  }
  return new ProviderRegistry({} as ProviderRegistry["sdkRegistry"], models);
}

function snapshot(value = config()): ModelRuntimeSnapshot {
  return new ModelRuntimeSnapshot({ revision: "revision-7", config: value, providerRegistry: registry(value) });
}

describe("ModelSelectionResolver", () => {
  test("resolves the current Profile default rather than trusting a stale accepted default selection", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: snapshot(),
      profile: "principal",
      requested: { mode: "profile_default", selection: { model: "local:beta", variant: "fast" } },
      sessionOverride: { model: "remote:gamma" },
    });

    expect(binding.summary.selection).toEqual({ model: "local:alpha", variant: "deep" });
    expect(binding.summary.resolution).toBe("profile_default");
  });

  test("uses a valid accepted Session override without leaking Profile options across providers", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: snapshot(),
      profile: "principal",
      requested: { mode: "session_override", selection: { model: "remote:gamma" } },
    });

    expect(binding.summary.selection).toEqual({ model: "remote:gamma" });
    expect(binding.summary.resolution).toBe("requested");
    expect(binding.options).toEqual({ frequencyPenalty: 0.4 });
    expect(binding.options).not.toHaveProperty("topK");
    expect(binding.options).not.toHaveProperty("providerOptions");
  });

  test("uses a durable Session override without Profile option leakage", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: snapshot(), profile: "principal", sessionOverride: { model: "local:beta", variant: "fast" },
    });
    expect(binding.summary.resolution).toBe("session_override");
    expect(binding.options).toEqual({ temperature: 0.4, presencePenalty: 0.5, maxOutputTokens: 2_000 });
  });

  test("falls back from invalid override input to the selected Profile", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: snapshot(),
      profile: "fast",
      requested: { mode: "session_override", selection: { model: "removed:model" } },
      sessionOverride: { model: "local:beta", variant: "removed" },
    });
    expect(binding.summary.selection).toEqual({ model: "local:beta", variant: "fast" });
    expect(binding.summary.resolution).toBe("profile_default");
  });

  test("shallow-merges model, variant, and Profile options only for Profile defaults", () => {
    const binding = new ModelSelectionResolver().resolve({ snapshot: snapshot(), profile: "principal" });
    expect(binding.options).toEqual({
      temperature: 0.3,
      topP: 0.7,
      maxOutputTokens: 8_000,
      topK: 4,
      providerOptions: { local: { layer: "profile" } },
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.summary.selection)).toBe(true);
    expect(Object.isFrozen(binding.options?.providerOptions)).toBe(true);
  });
});

describe("ModelRuntimeSnapshot", () => {
  test("publishes an immutable secret-free Profile catalog detached from input", () => {
    const value = config();
    const runtimeSnapshot = snapshot(value);
    value.profiles.principal.model = "remote:gamma";
    value.provider.local.name = "mutated";

    expect(runtimeSnapshot.catalog.profileDefaults).toEqual({
      principal: { model: "local:alpha", variant: "deep" },
      deep: { model: "local:alpha", variant: "deep" },
      fast: { model: "local:beta", variant: "fast" },
    });
    expect(runtimeSnapshot.catalog.providers[0]?.displayName).toBe("Local Provider");
    expect(JSON.stringify(runtimeSnapshot.catalog)).not.toContain("must-not-enter-catalog");
    expect(Object.isFrozen(runtimeSnapshot.catalog)).toBe(true);
  });

  test("rejects an invalid Profile binding and a registry missing a configured model", () => {
    const invalidProfile = config();
    invalidProfile.profiles.deep.variant = "removed";
    expect(() => snapshot(invalidProfile)).toThrow(InvalidModelRuntimeSnapshotError);

    const missingModel = config();
    const missingRegistry = registry(missingModel);
    (missingRegistry.models as Map<string, ModelInfo>).delete("local:beta");
    expect(() => new ModelRuntimeSnapshot({
      revision: "revision-8", config: missingModel, providerRegistry: missingRegistry,
    })).toThrow(InvalidModelRuntimeSnapshotError);
  });
});

describe("ModelRuntime", () => {
  test("prepares offline and publishes through one synchronous pointer", () => {
    const runtime = new ModelRuntime();
    const prepared = runtime.prepare(config(), "revision-9");
    expect(runtime.revision).toBeUndefined();
    runtime.publish(prepared);
    expect(runtime.current).toBe(prepared);
    expect(runtime.revision).toBe("revision-9");
  });
});
