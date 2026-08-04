import { describe, expect, test } from "bun:test";
import { safeConfigRecoveryStatus } from "./config-recovery";

describe("safe Config Recovery diagnostics", () => {
  test("removes dynamic Config keys and raw validation values", () => {
    const text = JSON.stringify(safeConfigRecoveryStatus(
      "/Users/test/.archcode/config.json",
      [{
        path: "provider.raw-secret-provider.options.raw-secret-option",
        message: "Unsupported provider package \"raw-secret-package\"",
      }, {
        path: "provider.raw-secret-provider.models.raw-secret-model.variants.raw-secret-variant.temperature",
        message: "raw-secret-value is invalid",
      }, {
        path: "mcp.servers.raw-secret-server.headers.raw-secret-header",
        message: "raw-secret-header-value is invalid",
      }, {
        path: "memory.raw-secret-field",
        message: "raw-secret-memory-value is invalid",
      }],
    ));

    expect(text).not.toContain("raw-secret");
    expect(JSON.parse(text)).toEqual({
      configPath: "/Users/test/.archcode/config.json",
      removableItems: [],
      issues: [{
        path: "provider.<provider>.options.<option>",
        message: "A configured provider package is not supported by this ArchCode release.",
      }, {
        path: "provider.<provider>.models.<model>.variants.<variant>",
        message: "This value does not match the current ArchCode configuration format.",
      }, {
        path: "mcp.servers.<server>.headers.<header>",
        message: "This value does not match the current ArchCode configuration format.",
      }, {
        path: "memory.<field>",
        message: "This value does not match the current ArchCode configuration format.",
      }],
    });
  });

  test("exposes only opaque removable identities and bounded impact descriptions", () => {
    const text = JSON.stringify(safeConfigRecoveryStatus(
      "/Users/test/.archcode/config.json",
      [],
      {
        revision: "revision-sentinel-safe",
        items: [{
          id: "abcdefghijklmnopqrstuv",
          path: ["provider", "raw-secret-provider", "models", "raw-secret-model"],
        }, {
          id: "zyxwvutsrqponmlkjihgfe",
          path: ["mcp", "servers", "raw-secret-server"],
        }],
      },
    ));

    expect(text).not.toContain("raw-secret");
    expect(JSON.parse(text)).toMatchObject({
      revision: "revision-sentinel-safe",
      removableItems: [{
        id: "abcdefghijklmnopqrstuv",
        label: "Invalid model entry",
        path: "provider.<provider>.models.<model>",
        impact: expect.stringContaining("Other models remain configured"),
      }, {
        id: "zyxwvutsrqponmlkjihgfe",
        label: "Invalid MCP server",
        path: "mcp.servers.<server>",
        impact: expect.stringContaining("Other MCP servers remain configured"),
      }],
    });
  });
});
