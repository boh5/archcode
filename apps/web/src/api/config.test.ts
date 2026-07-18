import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "./client";
import { getServerConfig, saveServerConfig, toConfigDraft, type ServerConfig } from "./config";

const config: ServerConfig = {
  provider: {},
  agents: {} as ServerConfig["agents"],
  memory: { enabled: true, minMessages: 5, minContentLength: 1000, cooldownMs: 300000 },
};

describe("config API", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
  });
  test("loads the one global config resource", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/config");
      return Response.json({ config, revision: "r1", configPath: "/home/a/.archcode/config.json", restartRequired: false });
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

  test("converts safe secret views into explicit preserve mutations", () => {
    const draft = toConfigDraft({
      config: {
        ...config,
        provider: {
          local: {
            npm: "@ai-sdk/openai-compatible",
            name: "Local",
            options: { baseURL: "http://localhost/v1", apiKey: { configured: true } },
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
      configPath: "/home/a/.archcode/config.json",
      restartRequired: false,
    });

    expect(draft.config.provider.local!.options.apiKey).toEqual({ action: "preserve" });
    expect(draft.config.provider.local!.models.demo.capabilities).toEqual({
      multiToolCallEmission: "single",
      structuredToolCalls: "best_effort",
      instructionTier: "standard",
    });
  });
});
