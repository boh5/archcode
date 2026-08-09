import { afterEach, describe, expect, test } from "bun:test";
import { REDACTION_MARKER } from "../security";
import {
  ConfigEnvExpansionError,
  archcodeConfigSchema,
  expandEnvVars,
  McpConfigEnvError,
  McpConfigError,
  mcpConfigSchema,
  mcpHttpServerConfigSchema,
  mcpServerConfigSchema,
  mcpServerNameSchema,
  mcpStdioServerConfigSchema,
  resolveMcpConfig,
  type McpConfig,
  type ResolvedMcpConfig,
  MCP_DEFAULT_CALL_TIMEOUT_MS,
  MCP_DEFAULT_CONNECT_TIMEOUT_MS,
  MCP_DEFAULT_DISCOVERY_TIMEOUT_MS,
  MCP_MAX_TIMEOUT_MS,
} from "./index";

const HTTP_SERVER = {
  type: "http" as const,
  enabled: true,
  url: "http://localhost:3000/mcp",
};

const STDIO_SERVER = {
  type: "stdio" as const,
  enabled: true,
  command: "mcp-server",
  args: ["--stdio"],
};

function makeValidConfig(): McpConfig {
  return {
    servers: {
      myserver: { ...HTTP_SERVER },
    },
  };
}

describe("mcpServerNameSchema", () => {
  test("accepts valid server names", () => {
    for (const name of ["myserver", "my-server", "my_server", "server.1", "a"]) {
      expect(mcpServerNameSchema.safeParse(name).success).toBe(true);
    }
  });

  test("rejects empty, spaced, slashed, special, and double-underscore names", () => {
    for (const name of ["", "my server", "my/server", "server@name", "my__server"]) {
      expect(mcpServerNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe("MCP transport schemas", () => {
  test("requires the HTTP discriminator and enable flag", () => {
    expect(mcpHttpServerConfigSchema.safeParse(HTTP_SERVER).success).toBe(true);
    expect(mcpHttpServerConfigSchema.safeParse({ url: HTTP_SERVER.url }).success).toBe(false);
    expect(mcpHttpServerConfigSchema.safeParse({ ...HTTP_SERVER, enabled: undefined }).success).toBe(false);
  });

  test("accepts HTTP headers and all bounded timeout fields", () => {
    const result = mcpHttpServerConfigSchema.safeParse({
      ...HTTP_SERVER,
      headers: { Authorization: "Bearer token" },
      connectTimeoutMs: MCP_DEFAULT_CONNECT_TIMEOUT_MS,
      discoveryTimeoutMs: MCP_DEFAULT_DISCOVERY_TIMEOUT_MS,
      callTimeoutMs: MCP_DEFAULT_CALL_TIMEOUT_MS,
    });
    expect(result.success).toBe(true);
  });

  test("requires the STDIO discriminator, enable flag, and command", () => {
    expect(mcpStdioServerConfigSchema.safeParse(STDIO_SERVER).success).toBe(true);
    expect(mcpStdioServerConfigSchema.safeParse({ type: "stdio", enabled: true }).success).toBe(false);
    expect(mcpStdioServerConfigSchema.safeParse({ ...STDIO_SERVER, command: "" }).success).toBe(false);
  });

  test("accepts STDIO args/env and rejects shell/cwd fields", () => {
    expect(mcpStdioServerConfigSchema.safeParse({
      ...STDIO_SERVER,
      env: { TOKEN: "secret" },
      connectTimeoutMs: 1,
      discoveryTimeoutMs: MCP_MAX_TIMEOUT_MS,
      callTimeoutMs: MCP_DEFAULT_CALL_TIMEOUT_MS,
    }).success).toBe(true);
    expect(mcpStdioServerConfigSchema.safeParse({ ...STDIO_SERVER, shell: "sh" }).success).toBe(false);
    expect(mcpStdioServerConfigSchema.safeParse({ ...STDIO_SERVER, cwd: "/tmp" }).success).toBe(false);
  });

  test("rejects non-positive, fractional, and over-bound timeouts", () => {
    for (const field of ["connectTimeoutMs", "discoveryTimeoutMs", "callTimeoutMs"] as const) {
      expect(mcpServerConfigSchema.safeParse({ ...HTTP_SERVER, [field]: 0 }).success).toBe(false);
      expect(mcpServerConfigSchema.safeParse({ ...HTTP_SERVER, [field]: 1.5 }).success).toBe(false);
      expect(mcpServerConfigSchema.safeParse({ ...HTTP_SERVER, [field]: MCP_MAX_TIMEOUT_MS + 1 }).success).toBe(false);
    }
  });

  test("rejects unknown transport fields in strict mode", () => {
    expect(mcpServerConfigSchema.safeParse({ ...HTTP_SERVER, unexpectedField: true }).success).toBe(false);
    expect(mcpServerConfigSchema.safeParse({ ...STDIO_SERVER, unexpectedField: true }).success).toBe(false);
  });
});

describe("mcpConfigSchema", () => {
  test("accepts HTTP, STDIO, and optional disabled built-ins", () => {
    const result = mcpConfigSchema.safeParse({
      disabledBuiltins: ["exa"],
      servers: {
        docs: HTTP_SERVER,
        local: STDIO_SERVER,
      },
    });
    expect(result.success).toBe(true);
  });

  test("requires unique known disabled built-in IDs", () => {
    expect(mcpConfigSchema.safeParse({ disabledBuiltins: ["exa", "exa"], servers: {} }).success).toBe(false);
    expect(mcpConfigSchema.safeParse({ disabledBuiltins: ["unknown"], servers: {} }).success).toBe(false);
  });

  test("keeps the top-level MCP object strict", () => {
    expect(mcpConfigSchema.safeParse({ servers: {}, extraKey: true }).success).toBe(false);
  });
});

describe("McpConfigError", () => {
  test("has the correct name and optional serverName", () => {
    expect(new McpConfigError("test error").name).toBe("McpConfigError");
    expect(new McpConfigError("test", "myserver").serverName).toBe("myserver");
  });
});

describe("McpConfigEnvError", () => {
  test("carries variableName/configPath without exposing values", () => {
    const error = new McpConfigEnvError("TOKEN", "mcp.servers.docs.headers.Authorization");
    expect(error.name).toBe("McpConfigEnvError");
    expect(error.variableName).toBe("TOKEN");
    expect(error.configPath).toBe("mcp.servers.docs.headers.Authorization");
    expect(error.message).toContain("TOKEN");
  });
});

describe("resolveMcpConfig", () => {
  test("returns empty disabled-builtins and servers when config is absent", () => {
    expect(resolveMcpConfig()).toEqual({ disabledBuiltins: [], servers: {} });
  });

  test("applies exact transport timeout defaults", () => {
    const result = resolveMcpConfig({
      servers: { http: HTTP_SERVER, stdio: STDIO_SERVER },
    });

    expect(result.servers.http).toMatchObject({
      type: "http",
      enabled: true,
      connectTimeoutMs: MCP_DEFAULT_CONNECT_TIMEOUT_MS,
      discoveryTimeoutMs: MCP_DEFAULT_DISCOVERY_TIMEOUT_MS,
      callTimeoutMs: MCP_DEFAULT_CALL_TIMEOUT_MS,
    });
    expect(result.servers.stdio).toMatchObject({
      type: "stdio",
      args: ["--stdio"],
      connectTimeoutMs: MCP_DEFAULT_CONNECT_TIMEOUT_MS,
      discoveryTimeoutMs: MCP_DEFAULT_DISCOVERY_TIMEOUT_MS,
      callTimeoutMs: MCP_DEFAULT_CALL_TIMEOUT_MS,
    });
  });

  test("preserves explicit timeout values and disabled state", () => {
    const config: McpConfig = {
      servers: {
        docs: {
          ...HTTP_SERVER,
          enabled: false,
          connectTimeoutMs: 11_000,
          discoveryTimeoutMs: 31_000,
          callTimeoutMs: 61_000,
        },
      },
    };
    const result = resolveMcpConfig(config);
    expect(result.servers.docs).toMatchObject({
      type: "http",
      enabled: false,
      connectTimeoutMs: 11_000,
      discoveryTimeoutMs: 31_000,
      callTimeoutMs: 61_000,
    });
  });

  test("retains the disabled built-in set without duplicates", () => {
    expect(resolveMcpConfig({ disabledBuiltins: ["context7", "exa"], servers: {} }).disabledBuiltins)
      .toEqual(["context7", "exa"]);
    expect(() => resolveMcpConfig({ disabledBuiltins: ["exa", "exa"] as never, servers: {} }))
      .toThrow(McpConfigError);
  });

  test("returns a resolved union with HTTP and STDIO fields", () => {
    const result: ResolvedMcpConfig = resolveMcpConfig({
      servers: {
        docs: { ...HTTP_SERVER, headers: { Authorization: "token" } },
        local: { ...STDIO_SERVER, env: { TOKEN: "secret" } },
      },
    });
    expect(result.servers.docs).toMatchObject({ type: "http", url: HTTP_SERVER.url, headers: { Authorization: "token" } });
    expect(result.servers.local).toMatchObject({ type: "stdio", command: "mcp-server", args: ["--stdio"], env: { TOKEN: "secret" } });
  });
});

describe("resolveMcpConfig environment expansion", () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  test("expands HTTP URL and header values using the supplied env", () => {
    const config: McpConfig = {
      servers: {
        docs: {
          ...HTTP_SERVER,
          url: "https://${MCP_HOST}/mcp",
          headers: { Authorization: "Bearer ${MCP_TOKEN}" },
        },
      },
    };
    const result = resolveMcpConfig(config, {
      MCP_HOST: "docs.example.test",
      MCP_TOKEN: "secret-token",
    });
    expect(result.servers.docs).toMatchObject({
      url: "https://docs.example.test/mcp",
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  test("expands STDIO env values but leaves command and args literal", () => {
    const result = resolveMcpConfig({
      servers: {
        local: {
          ...STDIO_SERVER,
          command: "${MCP_COMMAND}",
          args: ["${MCP_ARG}"],
          env: { TOKEN: "${MCP_TOKEN}" },
        },
      },
    }, {
      MCP_COMMAND: "not-used",
      MCP_ARG: "not-used",
      MCP_TOKEN: "stdio-secret",
    });
    expect(result.servers.local).toMatchObject({
      command: "${MCP_COMMAND}",
      args: ["${MCP_ARG}"],
      env: { TOKEN: "stdio-secret" },
    });
  });

  test("supports defaults and does not recursively expand values", () => {
    const result = resolveMcpConfig({
      servers: {
        docs: {
          ...HTTP_SERVER,
          url: "http://${MCP_HOST:-localhost}:3000/mcp",
          headers: { "X-Token": "${MCP_OUTER}" },
        },
      },
    }, {
      MCP_OUTER: "${MCP_INNER}",
    });
    expect(result.servers.docs).toMatchObject({
      url: "http://localhost:3000/mcp",
      headers: { "X-Token": "${MCP_INNER}" },
    });
  });

  test("reports missing HTTP header and STDIO env variables at exact paths", () => {
    expect(() => resolveMcpConfig({
      servers: { docs: { ...HTTP_SERVER, headers: { Authorization: "${MISSING_HEADER}" } } },
    }, {})).toThrow(McpConfigEnvError);
    try {
      resolveMcpConfig({
        servers: { local: { ...STDIO_SERVER, env: { TOKEN: "${MISSING_STDIO_ENV}" } } },
      }, {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfigEnvError);
      expect((error as McpConfigEnvError).configPath).toBe("mcp.servers.local.env.TOKEN");
    }
  });
});

describe("resolveMcpConfig URL validation", () => {
  test("accepts HTTP and HTTPS only", () => {
    expect(() => resolveMcpConfig({ servers: { docs: { ...HTTP_SERVER, url: "http://example.com/path" } } })).not.toThrow();
    expect(() => resolveMcpConfig({ servers: { docs: { ...HTTP_SERVER, url: "https://secure.example.com" } } })).not.toThrow();
  });

  test("rejects non-HTTP schemes and malformed URLs", () => {
    for (const url of ["ftp://files.example.com", "ws://socket.example.com", "not a valid url", "//example.com/rpc"]) {
      expect(() => resolveMcpConfig({ servers: { docs: { ...HTTP_SERVER, url } } })).toThrow(McpConfigError);
    }
  });

  test("redacts invalid URL values", () => {
    try {
      resolveMcpConfig({ servers: { docs: { ...HTTP_SERVER, url: "ftp://secret.example.com" } } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfigError);
      expect((error as McpConfigError).message).toContain(REDACTION_MARKER);
      expect((error as McpConfigError).message).not.toContain("secret.example.com");
    }
  });

  test("rejects malformed direct timeout values even when bypassing Zod", () => {
    expect(() => resolveMcpConfig({
      servers: { docs: { ...HTTP_SERVER, callTimeoutMs: MCP_MAX_TIMEOUT_MS + 1 } as never },
    })).toThrow(McpConfigError);
  });
});

describe("expandEnvVars", () => {
  test("retains shared ${VAR:-default} semantics outside MCP", () => {
    expect(expandEnvVars("token-env:${ARCHCODE_TOKEN_ENV_NAME:-GITHUB_TOKEN}", "integrations.github.tokenEnv", { env: {} }))
      .toBe("token-env:GITHUB_TOKEN");
  });

  test("throws a typed shared expansion error without leaking env values", () => {
    try {
      expandEnvVars("${MISSING_TOKEN_ENV}", "integrations.github.tokenEnv", { env: { OTHER_TOKEN: "secret-sentinel" } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigEnvExpansionError);
      expect((error as ConfigEnvExpansionError).variableName).toBe("MISSING_TOKEN_ENV");
      expect((error as ConfigEnvExpansionError).message).not.toContain("secret-sentinel");
    }
  });
});

describe("archcodeConfigSchema with MCP", () => {
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
    profiles: {
      principal: { model: "p:m" },
      deep: { model: "p:m" },
      fast: { model: "p:m" },
    },
  };

  test("accepts config without MCP and with the strict HTTP/STDIO shape", () => {
    expect(archcodeConfigSchema.safeParse(BASE).success).toBe(true);
    expect(archcodeConfigSchema.safeParse({
      ...BASE,
      mcp: { servers: { docs: HTTP_SERVER, local: STDIO_SERVER } },
    }).success).toBe(true);
  });

  test("rejects unknown MCP keys through the full config schema", () => {
    expect(archcodeConfigSchema.safeParse({
      ...BASE,
      mcp: { servers: { docs: HTTP_SERVER }, extraKey: "bad" },
    }).success).toBe(false);
    expect(archcodeConfigSchema.safeParse({
      ...BASE,
      mcp: { servers: { docs: { ...HTTP_SERVER, timeout: 30_000 } } },
    }).success).toBe(false);
  });
});
