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
            },
          },
        },
      },
      userMcp: {
        disabledBuiltins: [],
        servers: {
          private: {
            type: "http",
            enabled: true,
            url: "https://mcp.example.test/private",
            headers: { Authorization: "mcp-auth-header" },
            connectTimeoutMs: 10_000,
            discoveryTimeoutMs: 30_000,
            callTimeoutMs: 60_000,
          },
          local: {
            type: "stdio",
            enabled: true,
            command: "mcp-local",
            args: ["--stdio"],
            env: { TOKEN: "stdio-env-value" },
            connectTimeoutMs: 10_000,
            discoveryTimeoutMs: 30_000,
            callTimeoutMs: 60_000,
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
      "mcp-auth-header",
      "stdio-env-value",
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
            },
          },
        },
      },
      userMcp: { disabledBuiltins: [], servers: {} },
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
              },
            },
          },
        },
        userMcp: { disabledBuiltins: [], servers: {} },
        github: { enabled: false },
        externalLiterals: [],
      });
    } catch (error) {
      expect((error as ConfigSemanticValidationError).issues[0]?.path).toBe("provider.local.options.apiKey");
    }
  });
});
