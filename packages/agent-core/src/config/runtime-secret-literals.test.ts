import { describe, expect, test } from "bun:test";

import { ConfigSemanticValidationError } from "./server-config-service";
import { collectRuntimeSecretLiterals } from "./runtime-secret-literals";

describe("collectRuntimeSecretLiterals", () => {
  test("collects and deduplicates every resolved runtime source", () => {
    const registry = collectRuntimeSecretLiterals({
      providers: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "local",
          options: {
            baseURL: "https://provider.example.test/v1",
            apiKey: "provider-api-key",
            headers: { Authorization: "provider-header" },
            queryParams: { token: "provider-query" },
          },
          models: {
            test: {
              name: "test",
              limit: { context: 1000, output: 100 },
              modalities: { input: ["text"], output: ["text"] },
              capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
            },
          },
        },
      },
      userMcp: {
        servers: {
          private: {
            url: "https://mcp.example.test/private",
            headers: { Authorization: "mcp-auth-header" },
            timeout: 30_000,
          },
        },
      },
      github: { enabled: true, token: "github-token-value" },
      externalLiterals: ["server-password", "provider-api-key"],
    });

    expect(registry.values()).toEqual([
      "provider-api-key",
      "provider-header",
      "provider-query",
      "https://mcp.example.test/private",
      "mcp-auth-header",
      "github-token-value",
      "server-password",
    ]);
  });

  test("reports the exact source path for a boundary violation", () => {
    expect(() => collectRuntimeSecretLiterals({
      providers: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "local",
          options: { baseURL: "https://provider.example.test/v1", apiKey: "short" },
          models: {
            test: {
              name: "test",
              limit: { context: 1000, output: 100 },
              modalities: { input: ["text"], output: ["text"] },
              capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
            },
          },
        },
      },
      userMcp: { servers: {} },
      github: { enabled: false },
      externalLiterals: [],
    })).toThrow(ConfigSemanticValidationError);

    try {
      collectRuntimeSecretLiterals({
        providers: {
          local: {
            npm: "@ai-sdk/openai-compatible",
            name: "local",
            options: { baseURL: "https://provider.example.test/v1", apiKey: "short" },
            models: {
              test: {
                name: "test",
                limit: { context: 1000, output: 100 },
                modalities: { input: ["text"], output: ["text"] },
                capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
              },
            },
          },
        },
        userMcp: { servers: {} },
        github: { enabled: false },
        externalLiterals: [],
      });
    } catch (error) {
      expect((error as ConfigSemanticValidationError).issues[0]?.path).toBe("provider.local.options.apiKey");
    }
  });
});
