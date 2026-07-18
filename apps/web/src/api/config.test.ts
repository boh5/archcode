import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "./client";
import type { ProviderAdapterCatalog } from "@archcode/protocol";
import { getModelRuntimeCatalog, getProviderAdapterCatalog, getServerConfig, saveServerConfig, toConfigDraft, type ServerConfig } from "./config";

const config: ServerConfig = {
  provider: {},
  agents: {} as ServerConfig["agents"],
  memory: { enabled: true, minMessages: 5, minContentLength: 1000, cooldownMs: 300000 },
};

const adapterCatalog: ProviderAdapterCatalog = [{
  npmPackage: "@ai-sdk/openai-compatible",
  displayName: "OpenAI-compatible",
  fields: [
    { path: "baseURL", label: "Base URL", kind: "url", required: true, secret: false },
    { path: "apiKey", label: "API key", kind: "string", required: false, secret: true },
    { path: "headers", label: "Headers", kind: "json", required: false, secret: true },
    { path: "queryParams", label: "Query parameters", kind: "json", required: false, secret: true },
  ],
}];

describe("config API", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
  });
  test("loads the one global config resource", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/config");
      return Response.json({ config, revision: "r1", modelRuntimeRevision: "m1", configPath: "/home/a/.archcode/config.json", restartRequiredSections: [] });
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    await expect(getServerConfig()).resolves.toMatchObject({ revision: "r1" });
  });

  test("saves with expectedRevision and preserves server validation errors", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: "r1", config });
      return Response.json({ error: { code: "CONFIG_VALIDATION", message: "Invalid URL", details: { "provider.local.options.baseURL": "Invalid URL" } } }, { status: 422 });
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    await expect(saveServerConfig({ expectedRevision: "r1", config })).rejects.toMatchObject({
      code: "CONFIG_VALIDATION",
      details: { "provider.local.options.baseURL": "Invalid URL" },
    });
  });

  test("converts only catalog-declared secret views without mutating generic options", () => {
    const draft = toConfigDraft({
      config: {
        ...config,
        provider: {
          local: {
            npm: "@ai-sdk/openai-compatible",
            name: "Local",
            options: {
              baseURL: "http://localhost/v1",
              apiKey: { configured: true },
              queryParams: { token: { configured: true }, region: "test" },
              advancedFeature: { configured: true },
              nested: { keep: [1, { enabled: true }] },
            },
            models: {
              demo: {
                name: "Demo",
                limit: { context: 128000, output: 16000 },
                modalities: { input: ["text"], output: ["text"] },
                capabilities: {
                  multiToolCallEmission: "single",
                  structuredToolCalls: "best_effort",
                  instructionTier: "standard",
                },
              },
            },
          },
        },
      } as never,
      revision: "r1",
      modelRuntimeRevision: "m1",
      configPath: "/home/a/.archcode/config.json",
      restartRequiredSections: [],
    }, adapterCatalog);

    expect(draft.config.provider.local!.options.apiKey).toEqual({ action: "preserve" });
    expect(draft.config.provider.local!.models.demo.capabilities).toEqual({
      multiToolCallEmission: "single",
      structuredToolCalls: "best_effort",
      instructionTier: "standard",
    });
    expect(draft.config.provider.local!.options.queryParams).toEqual({
      token: { action: "preserve" },
      region: "test",
    });
    expect(draft.config.provider.local!.options.advancedFeature).toEqual({ configured: true });
    expect(draft.config.provider.local!.options.nested).toEqual({ keep: [1, { enabled: true }] });
  });

  test("loads Provider adapters and model runtime from their stable endpoints", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/config/provider-adapters") {
        return Response.json([{ npmPackage: "@ai-sdk/openai", displayName: "OpenAI", fields: [] }]);
      }
      if (String(input) === "/api/config/model-runtime") {
        return Response.json({ revision: "m1", providers: [], agentDefaults: {} });
      }
      return new Response(null, { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    await expect(getProviderAdapterCatalog()).resolves.toEqual([
      { npmPackage: "@ai-sdk/openai", displayName: "OpenAI", fields: [] },
    ]);
    await expect(getModelRuntimeCatalog()).resolves.toEqual({ revision: "m1", providers: [], agentDefaults: {} });
  });
});
