import { describe, expect, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ArchCodeConfig, ModelConfig } from "../config";
import { ModelInfo, ProviderRegistry } from "../provider";
import {
  InvalidModelRuntimeSnapshotError,
  ModelRuntimeSnapshot,
} from "./model-runtime-snapshot";
import { ModelRuntime } from "./model-runtime";
import { ModelSelectionResolver } from "./model-selection-resolver";

const AGENT_NAMES = [
  "engineer",
  "goal_lead",
  "plan",
  "build",
  "reviewer",
  "explore",
  "librarian",
  "shaper",
] as const;

function makeModelConfig(
  name: string,
  options?: ModelConfig["options"],
  variants?: ModelConfig["variants"],
): ModelConfig {
  return {
    name,
    limit: { context: 100_000, output: 10_000 },
    modalities: { input: ["text"], output: ["text"] },
    options,
    variants,
  };
}

function makeConfig(): ArchCodeConfig {
  const defaultAgent = {
    model: "local:alpha",
    variant: "deep",
    options: {
      temperature: 0.3,
      topK: 4,
      providerOptions: { local: { layer: "agent" } },
    },
  };

  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Provider",
        options: {
          baseURL: "http://localhost:8090/v1",
          apiKey: "must-not-enter-catalog",
        },
        models: {
          alpha: makeModelConfig(
            "Alpha",
            {
              temperature: 0.1,
              topP: 0.7,
              providerOptions: { local: { layer: "model" } },
            },
            {
              deep: {
                temperature: 0.2,
                maxOutputTokens: 8_000,
                providerOptions: { local: { layer: "variant" } },
              },
            },
          ),
          beta: makeModelConfig(
            "Beta",
            { temperature: 0.4, presencePenalty: 0.5 },
            { fast: { maxOutputTokens: 2_000 } },
          ),
        },
      },
    },
    agents: {
      engineer: structuredClone(defaultAgent),
      goal_lead: structuredClone(defaultAgent),
      plan: structuredClone(defaultAgent),
      build: structuredClone(defaultAgent),
      reviewer: structuredClone(defaultAgent),
      explore: structuredClone(defaultAgent),
      librarian: structuredClone(defaultAgent),
      shaper: structuredClone(defaultAgent),
    },
  };
}

function makeRegistry(config: ArchCodeConfig): ProviderRegistry {
  const models = new Map<string, ModelInfo>();

  for (const [providerId, provider] of Object.entries(config.provider)) {
    for (const [modelId, modelConfig] of Object.entries(provider.models)) {
      const info = new ModelInfo({
        model: {} as LanguageModelV3,
        config: modelConfig,
        providerId,
        modelId,
      });
      models.set(info.qualifiedId, info);
    }
  }

  return new ProviderRegistry(
    {} as ProviderRegistry["sdkRegistry"],
    models,
  );
}

function makeSnapshot(config = makeConfig()): ModelRuntimeSnapshot {
  return new ModelRuntimeSnapshot({
    revision: "revision-7",
    config,
    providerRegistry: makeRegistry(config),
  });
}

describe("ModelSelectionResolver", () => {
  test("uses a valid accepted-message request before Session override and Agent default", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: makeSnapshot(),
      agentName: "engineer",
      requested: {
        mode: "agent_default",
        selection: { model: "local:beta", variant: "fast" },
      },
      sessionOverride: { model: "local:alpha", variant: "deep" },
    });

    expect(binding.summary).toEqual({
      selection: { model: "local:beta", variant: "fast" },
      providerId: "local",
      modelId: "beta",
      providerDisplayName: "Local Provider",
      modelDisplayName: "Beta",
      resolution: "requested",
      modelRuntimeRevision: "revision-7",
    });
    expect(binding.modelInfo.qualifiedId).toBe("local:beta");
  });

  test("falls back from an invalid request to the current valid Session override", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: makeSnapshot(),
      agentName: "engineer",
      requested: {
        mode: "session_override",
        selection: { model: "removed:model", variant: "gone" },
      },
      sessionOverride: { model: "local:beta", variant: "fast" },
    });

    expect(binding.summary.selection).toEqual({ model: "local:beta", variant: "fast" });
    expect(binding.summary.resolution).toBe("session_override");
  });

  test("uses the current Session override when there is no accepted-message request", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: makeSnapshot(),
      agentName: "engineer",
      sessionOverride: { model: "local:beta", variant: "fast" },
    });

    expect(binding.summary.selection).toEqual({ model: "local:beta", variant: "fast" });
    expect(binding.summary.resolution).toBe("session_override");
  });

  test("falls back from invalid request and override to the current Agent default", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: makeSnapshot(),
      agentName: "engineer",
      requested: {
        mode: "session_override",
        selection: { model: "local:alpha", variant: "removed" },
      },
      sessionOverride: { model: "local:beta", variant: "removed" },
    });

    expect(binding.summary.selection).toEqual({ model: "local:alpha", variant: "deep" });
    expect(binding.summary.resolution).toBe("agent_default");
  });

  test("shallow-merges model, selected variant, and Agent call options", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: makeSnapshot(),
      agentName: "engineer",
    });

    expect(binding.options).toEqual({
      temperature: 0.3,
      topP: 0.7,
      maxOutputTokens: 8_000,
      topK: 4,
      providerOptions: { local: { layer: "agent" } },
    });
  });

  test("returns an immutable binding, summary, selection, and merged options", () => {
    const binding = new ModelSelectionResolver().resolve({
      snapshot: makeSnapshot(),
      agentName: "engineer",
    });

    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.summary)).toBe(true);
    expect(Object.isFrozen(binding.summary.selection)).toBe(true);
    expect(Object.isFrozen(binding.options)).toBe(true);
    expect(Object.isFrozen(binding.options?.providerOptions)).toBe(true);
  });
});

describe("ModelRuntimeSnapshot", () => {
  test("publishes an immutable secret-free catalog and copies input config", () => {
    const config = makeConfig();
    const snapshot = makeSnapshot(config);
    config.provider.local.name = "Mutated after construction";
    config.agents.engineer.model = "local:beta";

    expect(snapshot.catalog).toEqual({
      revision: "revision-7",
      providers: [{
        id: "local",
        displayName: "Local Provider",
        models: [{
          id: "alpha",
          qualifiedId: "local:alpha",
          displayName: "Alpha",
          variants: ["deep"],
        }, {
          id: "beta",
          qualifiedId: "local:beta",
          displayName: "Beta",
          variants: ["fast"],
        }],
      }],
      agentDefaults: Object.fromEntries(
        AGENT_NAMES.map((agentName) => [
          agentName,
          { model: "local:alpha", variant: "deep" },
        ]),
      ),
    });
    expect(JSON.stringify(snapshot.catalog)).not.toContain("must-not-enter-catalog");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.catalog.providers[0]?.models[0]?.variants)).toBe(true);
  });

  test("rejects a snapshot whose Agent default selection is invalid", () => {
    const config = makeConfig();
    config.agents.engineer.variant = "removed";

    expect(() => makeSnapshot(config)).toThrow(InvalidModelRuntimeSnapshotError);
  });

  test("rejects configured models absent from the Provider registry", () => {
    const config = makeConfig();
    const registry = makeRegistry(config);
    (registry.models as Map<string, ModelInfo>).delete("local:beta");

    expect(() => new ModelRuntimeSnapshot({
      revision: "revision-8",
      config,
      providerRegistry: registry,
    })).toThrow(InvalidModelRuntimeSnapshotError);
  });
});

describe("ModelRuntime", () => {
  test("detaches Provider factory options from caller-owned config before preparing", () => {
    const runtime = new ModelRuntime();
    const config = makeConfig();
    config.provider.local.options.headers = { "x-secret": "original-header-secret" };
    const prepared = runtime.prepare(config, "revision-detached");

    config.provider.local.options.headers["x-secret"] = "mutated-header-secret";
    const modelInfo = prepared.tryResolveSelection({ model: "local:alpha" })!.modelInfo;

    expect(modelInfo.redactSensitiveText("original-header-secret")).toBe("[REDACTED_PROVIDER_SECRET]");
    expect(modelInfo.redactSensitiveText("mutated-header-secret")).toBe("mutated-header-secret");
    expect(prepared.catalog.providers[0]?.displayName).toBe("Local Provider");
  });

  test("prepares offline and publishes through one synchronous pointer", () => {
    const runtime = new ModelRuntime();
    const prepared = runtime.prepare(makeConfig(), "revision-9");

    expect(runtime.revision).toBeUndefined();
    runtime.publish(prepared);
    expect(runtime.current).toBe(prepared);
    expect(runtime.revision).toBe("revision-9");
  });

  test("notifies subscribers only when the published revision changes", () => {
    const runtime = new ModelRuntime();
    const revisions: string[] = [];
    const unsubscribe = runtime.subscribe((snapshot) => revisions.push(snapshot.revision));
    const first = runtime.prepare(makeConfig(), "revision-1");

    runtime.publish(first);
    runtime.publish(runtime.prepare(makeConfig(), "revision-1"));
    runtime.publish(runtime.prepare(makeConfig(), "revision-2"));
    unsubscribe();
    runtime.publish(runtime.prepare(makeConfig(), "revision-3"));

    expect(revisions).toEqual(["revision-1", "revision-2"]);
  });

  test("keeps publication committed when a subscriber throws", () => {
    const runtime = new ModelRuntime();
    runtime.subscribe(() => {
      throw new Error("observer failed");
    });
    const prepared = runtime.prepare(makeConfig(), "revision-4");

    expect(() => runtime.publish(prepared)).not.toThrow();
    expect(runtime.current).toBe(prepared);
  });
});
