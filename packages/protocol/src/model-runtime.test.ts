import { describe, expect, test } from "bun:test";
import type {
  ExecutionModelBindingSummary,
  MessageModelAudit,
  ModelRuntimeCatalog,
  RequestedModelSelection,
} from "./model-runtime";

function serializeRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("model runtime protocol contracts", () => {
  test("keeps requested selection and actual Execution binding separate", () => {
    const requested = {
      mode: "session_override",
      selection: { model: "local:old-model", variant: "deep" },
    } satisfies RequestedModelSelection;
    const binding = {
      selection: { model: "local:new-model", variant: "fast" },
      providerId: "local",
      modelId: "new-model",
      providerDisplayName: "Local",
      modelDisplayName: "New Model",
      resolution: "agent_default",
      modelRuntimeRevision: "revision-2",
    } satisfies ExecutionModelBindingSummary;
    const audit = {
      requested,
      actual: binding.selection,
      reason: "config_invalidated",
    } satisfies MessageModelAudit;

    expect(serializeRoundTrip({ binding, audit })).toEqual({ binding, audit });
    expect("executionOrigin" in binding).toBe(false);
  });

  test("represents the secret-free Provider, Model, Variant, and Agent catalog", () => {
    const catalog = {
      revision: "revision-3",
      providers: [{
        id: "local",
        displayName: "Local",
        models: [{
          id: "glm-5",
          qualifiedId: "local:glm-5",
          displayName: "GLM-5",
          variants: ["fast", "deep"],
        }],
      }],
      agentDefaults: {
        engineer: { model: "local:glm-5", variant: "deep" },
      },
    } satisfies ModelRuntimeCatalog;

    expect(serializeRoundTrip(catalog)).toEqual(catalog);
    expect(JSON.stringify(catalog)).not.toContain("apiKey");
    expect(JSON.stringify(catalog)).not.toContain("options");
  });
});
