import { afterEach, describe, expect, test } from "bun:test";
import { REDACTION_MARKER } from "../tools/security";
import {
  ConfigEnvExpansionError,
  type McpConfig,
  McpConfigEnvError,
  McpConfigError,
  type ResolvedMcpConfig,
  mcpConfigSchema,
  mcpServerConfigSchema,
  mcpServerNameSchema,
  resolveMcpConfig,
  expandEnvVars,
} from "./index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_SERVER = {
  url: "http://localhost:3000",
};

function makeValidConfig(): McpConfig {
  return {
    servers: {
      myserver: { ...VALID_SERVER },
    },
  };
}

// ─── Schema Validation ───────────────────────────────────────────────────────

describe("mcpServerNameSchema", () => {
  test("accepts valid server names", () => {
    expect(mcpServerNameSchema.safeParse("myserver").success).toBe(true);
    expect(mcpServerNameSchema.safeParse("my-server").success).toBe(true);
    expect(mcpServerNameSchema.safeParse("my_server").success).toBe(true);
    expect(mcpServerNameSchema.safeParse("server.1").success).toBe(true);
    expect(mcpServerNameSchema.safeParse("a").success).toBe(true);
  });

  test("rejects empty server name", () => {
    const result = mcpServerNameSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  test("rejects spaces in server name", () => {
    const result = mcpServerNameSchema.safeParse("my server");
    expect(result.success).toBe(false);
  });

  test("rejects slashes in server name", () => {
    const result = mcpServerNameSchema.safeParse("my/server");
    expect(result.success).toBe(false);
  });

  test("rejects special characters in server name", () => {
    const result = mcpServerNameSchema.safeParse("server@name");
    expect(result.success).toBe(false);
  });

  test("rejects double underscore in server name", () => {
    const result = mcpServerNameSchema.safeParse("my__server");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("double underscore");
    }
  });
});

describe("mcpServerConfigSchema", () => {
  test("accepts valid minimal config", () => {
    const result = mcpServerConfigSchema.safeParse(VALID_SERVER);
    expect(result.success).toBe(true);
  });

  test("accepts config with all optional fields", () => {
    const result = mcpServerConfigSchema.safeParse({
      ...VALID_SERVER,
      headers: { Authorization: "Bearer token" },
      timeout: 60000,
    });
    expect(result.success).toBe(true);
  });

  test("rejects the removed transport field", () => {
    const result = mcpServerConfigSchema.safeParse({
      transport: "http",
      url: "http://localhost:3000",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty url", () => {
    const result = mcpServerConfigSchema.safeParse({
      url: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects timeout of 0", () => {
    const result = mcpServerConfigSchema.safeParse({
      ...VALID_SERVER,
      timeout: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative timeout", () => {
    const result = mcpServerConfigSchema.safeParse({
      ...VALID_SERVER,
      timeout: -1,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer timeout", () => {
    const result = mcpServerConfigSchema.safeParse({
      ...VALID_SERVER,
      timeout: 1.5,
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown keys (strict mode)", () => {
    const result = mcpServerConfigSchema.safeParse({
      ...VALID_SERVER,
      unknownKey: "value",
    });
    expect(result.success).toBe(false);
  });
});

describe("mcpConfigSchema", () => {
  test("accepts valid config with one server", () => {
    const result = mcpConfigSchema.safeParse(makeValidConfig());
    expect(result.success).toBe(true);
  });

  test("accepts config with multiple servers", () => {
    const result = mcpConfigSchema.safeParse({
      servers: {
        a: { ...VALID_SERVER },
        b: { ...VALID_SERVER },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty servers object", () => {
    const result = mcpConfigSchema.safeParse({ servers: {} });
    expect(result.success).toBe(true);
  });

  test("rejects unknown keys on mcp config", () => {
    const result = mcpConfigSchema.safeParse({
      servers: { s: { ...VALID_SERVER } },
      builtin: true,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string header values", () => {
    const result = mcpServerConfigSchema.safeParse({
      ...VALID_SERVER,
      headers: { key: 42 },
    });
    expect(result.success).toBe(false);
  });
});

// ─── Named Error Classes ─────────────────────────────────────────────────────

describe("McpConfigError", () => {
  test("has the correct name", () => {
    const err = new McpConfigError("test error");
    expect(err.name).toBe("McpConfigError");
  });

  test("carries optional serverName", () => {
    const err = new McpConfigError("test", "myserver");
    expect(err.serverName).toBe("myserver");
  });

  test("works without serverName", () => {
    const err = new McpConfigError("test");
    expect(err.serverName).toBeUndefined();
  });
});

describe("McpConfigEnvError", () => {
  test("has the correct name", () => {
    const err = new McpConfigEnvError("API_KEY", "mcp.servers.s.url");
    expect(err.name).toBe("McpConfigEnvError");
  });

  test("carries variableName and configPath", () => {
    const err = new McpConfigEnvError("MY_VAR", "mcp.servers.s.url");
    expect(err.variableName).toBe("MY_VAR");
    expect(err.configPath).toBe("mcp.servers.s.url");
  });

  test("message includes variable name and path", () => {
    const err = new McpConfigEnvError("TOKEN", "mcp.servers.mine.url");
    expect(err.message).toContain("TOKEN");
    expect(err.message).toContain("mcp.servers.mine.url");
  });
});

// ─── Env Expansion ───────────────────────────────────────────────────────────

describe("resolveMcpConfig - env expansion", () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  test("resolves ${VAR} from process.env", () => {
    process.env.MCP_TEST_HOST = "http://resolved-host:8080";
    const config = makeValidConfig();
    config.servers.myserver.url = "${MCP_TEST_HOST}";

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.url).toBe("http://resolved-host:8080");
  });

  test("resolves ${VAR} in the middle of a url", () => {
    process.env.MCP_TEST_PORT = "9090";
    const config = makeValidConfig();
    config.servers.myserver.url = "http://localhost:${MCP_TEST_PORT}/path";

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.url).toBe("http://localhost:9090/path");
  });

  test("uses ${VAR:-default} when env is undefined", () => {
    delete process.env.MCP_TEST_MISSING;
    const config = makeValidConfig();
    config.servers.myserver.url = "${MCP_TEST_MISSING:-http://default:3000}";

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.url).toBe("http://default:3000");
  });

  test("uses ${VAR:-default} when env is empty string", () => {
    process.env.MCP_TEST_EMPTY = "";
    const config = makeValidConfig();
    config.servers.myserver.url = "${MCP_TEST_EMPTY:-http://fallback}";

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.url).toBe("http://fallback");
  });

  test("uses env value over ${VAR:-default} when env is set", () => {
    process.env.MCP_TEST_WITH_DEFAULT = "http://env-value";
    const config = makeValidConfig();
    config.servers.myserver.url = "${MCP_TEST_WITH_DEFAULT:-http://default}";

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.url).toBe("http://env-value");
  });

  test("throws McpConfigEnvError for missing ${VAR} without default", () => {
    delete process.env.MCP_TEST_REQUIRED;
    const config = makeValidConfig();
    config.servers.myserver.url = "${MCP_TEST_REQUIRED}";

    expect(() => resolveMcpConfig(config)).toThrow(McpConfigEnvError);
  });

  test("throws McpConfigEnvError for empty ${VAR} without default", () => {
    process.env.MCP_TEST_REQUIRED_EMPTY = "";
    const config = makeValidConfig();
    config.servers.myserver.url = "${MCP_TEST_REQUIRED_EMPTY}";

    expect(() => resolveMcpConfig(config)).toThrow(McpConfigEnvError);
  });

  test("McpConfigEnvError has correct variableName and configPath", () => {
    delete process.env.MCP_TEST_VAR;
    const config = makeValidConfig();
    config.servers.myserver.url = "${MCP_TEST_VAR}";

    try {
      resolveMcpConfig(config);
      expect.unreachable();
    } catch (err) {
      if (err instanceof McpConfigEnvError) {
        expect(err.variableName).toBe("MCP_TEST_VAR");
        expect(err.configPath).toBe("mcp.servers.myserver.url");
      }
    }
  });

  test("expands env vars in header values", () => {
    process.env.MCP_TEST_TOKEN = "secret-token";
    const config = makeValidConfig();
    config.servers.myserver.headers = {
      Authorization: "Bearer ${MCP_TEST_TOKEN}",
    };

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.headers?.Authorization).toBe(
      "Bearer secret-token",
    );
  });

  test("expands env vars with default in header values", () => {
    delete process.env.MCP_TEST_AUTH;
    const config = makeValidConfig();
    config.servers.myserver.headers = {
      Authorization: "${MCP_TEST_AUTH:-default-token}",
    };

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.headers?.Authorization).toBe(
      "default-token",
    );
  });

  test("does not perform recursive expansion", () => {
    process.env.MCP_OUTER = "${MCP_INNER}";
    process.env.MCP_INNER = "real-value";
    const config = makeValidConfig();
    config.servers.myserver.headers = {
      Authorization: "${MCP_OUTER}",
    };

    const result = resolveMcpConfig(config);
    // Outer resolves to literal "${MCP_INNER}" without further expansion
    expect(result.servers.myserver.headers?.Authorization).toBe(
      "${MCP_INNER}",
    );
  });

  test("supports defaults containing the delimiter substring", () => {
    delete process.env.MCP_TEST_DEFAULT_WITH_DELIMITER;
    const config = makeValidConfig();
    config.servers.myserver.headers = {
      "X-Default": "${MCP_TEST_DEFAULT_WITH_DELIMITER:-left:-right}",
    };

    const result = resolveMcpConfig(config);

    expect(result.servers.myserver.headers?.["X-Default"]).toBe("left:-right");
  });

  test("reports header env expansion failures at the server path", () => {
    delete process.env.MCP_TEST_MISSING_HEADER;
    const config = makeValidConfig();
    config.servers.myserver.headers = {
      Authorization: "Bearer ${MCP_TEST_MISSING_HEADER}",
    };

    try {
      resolveMcpConfig(config);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(McpConfigEnvError);
      expect((err as McpConfigEnvError).variableName).toBe(
        "MCP_TEST_MISSING_HEADER",
      );
      expect((err as McpConfigEnvError).configPath).toBe(
        "mcp.servers.myserver",
      );
    }
  });
});

describe("expandEnvVars", () => {
  test("uses shared ${VAR:-default} semantics outside mcp", () => {
    const expanded = expandEnvVars(
      "token-env:${ARCHCODE_TOKEN_ENV_NAME:-GITHUB_TOKEN}",
      "integrations.github.tokenEnv",
      { env: {} },
    );

    expect(expanded).toBe("token-env:GITHUB_TOKEN");
  });

  test("throws a typed shared env expansion error without leaking env values", () => {
    try {
      expandEnvVars("${MISSING_TOKEN_ENV}", "integrations.github.tokenEnv", {
        env: { OTHER_TOKEN: "secret-sentinel" },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigEnvExpansionError);
      expect((err as ConfigEnvExpansionError).variableName).toBe("MISSING_TOKEN_ENV");
      expect((err as ConfigEnvExpansionError).message).not.toContain("secret-sentinel");
    }
  });
});

// ─── resolveMcpConfig ──────────────────────────────────────────────────────

describe("resolveMcpConfig", () => {
  test("returns empty config when undefined", () => {
    const result = resolveMcpConfig(undefined);
    expect(result).toEqual({ servers: {} });
  });

  test("returns empty config when no argument", () => {
    const result = resolveMcpConfig();
    expect(result).toEqual({ servers: {} });
  });

  test("applies default timeout of 30000", () => {
    const config = makeValidConfig();
    delete (config.servers.myserver as Record<string, unknown>).timeout;

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.timeout).toBe(30000);
  });

  test("preserves explicit timeout", () => {
    const config = makeValidConfig();
    config.servers.myserver.timeout = 60000;

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.timeout).toBe(60000);
  });

  test("preserves headers", () => {
    const config = makeValidConfig();
    config.servers.myserver.headers = { "X-Custom": "value" };

    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.headers).toEqual({ "X-Custom": "value" });
  });

  test("returns undefined headers when none provided", () => {
    const config = makeValidConfig();
    const result = resolveMcpConfig(config);
    expect(result.servers.myserver.headers).toBeUndefined();
  });

  test("resolves multiple servers", () => {
    const config = makeValidConfig();
    config.servers.server2 = { ...VALID_SERVER };

    const result = resolveMcpConfig(config);
    expect(Object.keys(result.servers).sort()).toEqual([
      "myserver",
      "server2",
    ]);
  });

  test("returns ResolvedMcpConfig shape with proper interface", () => {
    const result: ResolvedMcpConfig = resolveMcpConfig(makeValidConfig());
    expect(result.servers.myserver).toMatchObject({
      url: "http://localhost:3000",
      timeout: 30000,
    });
  });
});

// ─── URL Validation ─────────────────────────────────────────────────────────

describe("resolveMcpConfig - URL validation", () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  test("accepts http:// URL", () => {
    const config = makeValidConfig();
    config.servers.myserver.url = "http://example.com/path";
    expect(() => resolveMcpConfig(config)).not.toThrow();
  });

  test("accepts https:// URL", () => {
    const config = makeValidConfig();
    config.servers.myserver.url = "https://secure.example.com";
    expect(() => resolveMcpConfig(config)).not.toThrow();
  });

  test("rejects ftp:// URL", () => {
    const config = makeValidConfig();
    config.servers.myserver.url = "ftp://files.example.com";
    expect(() => resolveMcpConfig(config)).toThrow(McpConfigError);
  });

  test("rejects ws:// URL", () => {
    const config = makeValidConfig();
    config.servers.myserver.url = "ws://socket.example.com";
    expect(() => resolveMcpConfig(config)).toThrow(McpConfigError);
  });

  test("rejects structurally invalid URL", () => {
    const config = makeValidConfig();
    config.servers.myserver.url = "not a valid url";
    expect(() => resolveMcpConfig(config)).toThrow(McpConfigError);
  });

  test("rejects protocol-relative URLs", () => {
    const config = makeValidConfig();
    config.servers.myserver.url = "//example.com/rpc";
    expect(() => resolveMcpConfig(config)).toThrow(McpConfigError);
  });

  test("error message contains REDACTION_MARKER not the URL", () => {
    const config = makeValidConfig();
    config.servers.myserver.url = "ftp://secret-ftp.example.com";
    try {
      resolveMcpConfig(config);
      expect.unreachable();
    } catch (err) {
      if (err instanceof McpConfigError) {
        expect(err.message).toContain(REDACTION_MARKER);
        expect(err.message).not.toContain("secret-ftp");
      }
    }
  });

  test("rejects non-http URL after env expansion", () => {
    process.env.MCP_TEST_PROTO = "ws";
    const config = makeValidConfig();
    config.servers.myserver.url = "${MCP_TEST_PROTO}://chat";

    expect(() => resolveMcpConfig(config)).toThrow(McpConfigError);
  });
});

// ─── Config Schema Integration ───────────────────────────────────────────────

import { archcodeConfigSchema } from "./index";

describe("archcodeConfigSchema with mcp", () => {
  const BASE = {
    provider: {
      p: {
        npm: "@ai-sdk/openai-compatible",
        name: "p",
        options: { baseURL: "http://localhost:8090/v1" },
        models: {
          m: {
            name: "M",
            limit: { context: 1000, output: 1000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agents: {
      engineer: { model: "p:m" },
      goal_lead: { model: "p:m" },
      plan: { model: "p:m" },
      build: { model: "p:m" },
      reviewer: { model: "p:m" },
      explore: { model: "p:m" },
      librarian: { model: "p:m" },
      shaper: { model: "p:m" },
    },
  };

  test("accepts config without mcp key", () => {
    const result = archcodeConfigSchema.safeParse(BASE);
    expect(result.success).toBe(true);
  });

  test("accepts config with valid mcp", () => {
    const result = archcodeConfigSchema.safeParse({
      ...BASE,
      mcp: { servers: { s: { url: "http://localhost" } } },
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown keys when mcp is present (strict on both levels)", () => {
    const result = archcodeConfigSchema.safeParse({
      ...BASE,
      mcp: {
        servers: { s: { url: "http://localhost" } },
        extraKey: "bad",
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects the removed transport field in full config", () => {
    const result = archcodeConfigSchema.safeParse({
      ...BASE,
      mcp: {
        servers: { s: { transport: "http", url: "http://localhost" } },
      },
    });
    expect(result.success).toBe(false);
  });
});
