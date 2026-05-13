import { afterEach, describe, expect, mock, test } from "bun:test";
import { McpConfigError, type ResolvedMcpServerConfig } from "../config/mcp";
import { REDACTION_MARKER } from "../tools/security";
import type {
  McpClientFactories,
  McpSdkClientLike,
  McpToolLike,
  McpTransportLike,
} from "./client";
import { BUILTIN_MCP_SERVERS } from "./builtin-servers";
import { McpManager } from "./manager";

// ─── Builtin Servers ──────────────────────────────────────────────────────────

describe("BUILTIN_MCP_SERVERS", () => {
  test("contains context7, grep.app, and exa", () => {
    const names = Object.keys(BUILTIN_MCP_SERVERS).sort();
    expect(names).toEqual(["context7", "exa", "grep.app"]);
  });

  test("each server has required ResolvedMcpServerConfig fields", () => {
    for (const [name, config] of Object.entries(BUILTIN_MCP_SERVERS)) {
      expect(config.transport).toBe("http");
      expect(config.url).toStartWith("https://");
      expect(config.timeout).toBeGreaterThan(0);
      expect(config.headers).toBeUndefined();
    }
  });

  test("server names pass MCP name validation", () => {
    for (const name of Object.keys(BUILTIN_MCP_SERVERS)) {
      expect(name).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(name).not.toContain("__");
    }
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_SERVER: ResolvedMcpServerConfig = {
  transport: "http",
  url: "https://mcp.example.test/rpc",
  timeout: 50,
};

interface FakeServer {
  sdkClient: McpSdkClientLike;
  transport: McpTransportLike;
  factories: McpClientFactories;
  connectOrder: string[];
  closeOrder: string[];
}

function tool(name: string): McpToolLike {
  return { name, description: `${name} description` };
}

function makeConfig(
  overrides: Partial<ResolvedMcpServerConfig> = {},
): ResolvedMcpServerConfig {
  return { ...BASE_SERVER, ...overrides };
}

function makeFakeServer(
  tools: McpToolLike[],
  overrides: Partial<McpSdkClientLike> = {},
  transportOverrides: Partial<McpTransportLike> = {},
): FakeServer {
  const connectOrder: string[] = [];
  const closeOrder: string[] = [];

  const sdkClient: McpSdkClientLike = {
    connect: mock(async () => {
      connectOrder.push("connect");
    }),
    listTools: mock(async () => ({ tools })),
    callTool: mock(async () => ({ content: [{ type: "text", text: "ok" }] })),
    close: mock(async () => {
      closeOrder.push("client");
    }),
    ...overrides,
  };

  const transport: McpTransportLike = {
    close: mock(async () => {
      closeOrder.push("transport");
    }),
    ...transportOverrides,
  };

  return {
    sdkClient,
    transport,
    connectOrder,
    closeOrder,
    factories: {
      createClient: mock(() => sdkClient),
      createTransport: mock(() => transport),
    },
  };
}

function managerWithClientRoutes(
  builtinServers: Record<string, ResolvedMcpServerConfig>,
  userServers: Record<string, ResolvedMcpServerConfig>,
  routes: Record<string, FakeServer>,
): McpManager {
  const serverNames = Object.keys({ ...builtinServers, ...userServers });
  let nextServerIndex = 0;
  let constructingServerName: string | undefined;

  const factories: McpClientFactories = {
    createClient: mock(() => {
      constructingServerName = serverNames[nextServerIndex++];
      if (!constructingServerName) throw new Error("missing server route");
      return routes[constructingServerName].sdkClient;
    }),
    createTransport: mock(() => {
      if (!constructingServerName) throw new Error("missing server transport route");
      return routes[constructingServerName].transport;
    }),
  };

  return new McpManager(builtinServers, userServers, factories);
}

afterEach(() => {
  mock.restore();
});

// ─── Merge And Validation ────────────────────────────────────────────────────

describe("McpManager discovery", () => {
  test("merges empty built-ins with user servers", async () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const result = await manager.discover();

    expect(result.warnings).toEqual([]);
    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual([
      "mcp__docs__lookup",
    ]);
    expect(fake.sdkClient.connect).toHaveBeenCalledTimes(1);
    expect(fake.sdkClient.listTools).toHaveBeenCalledTimes(1);
  });

  test("builtin and user server name collision fails before discovery", async () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager(
      { docs: makeConfig({ url: "https://builtin.example.test/rpc" }) },
      { docs: makeConfig({ url: "https://user.example.test/rpc" }) },
      fake.factories,
    );

    try {
      await manager.discover();
      throw new Error("Expected discover to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(McpConfigError);
    }
    expect(fake.factories.createClient).not.toHaveBeenCalled();
    expect(fake.factories.createTransport).not.toHaveBeenCalled();
  });

  test("discovers multiple servers without serially waiting for earlier servers", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = makeFakeServer([tool("first")], {
      connect: mock(async () => {
        first.connectOrder.push("started");
        await firstGate;
      }),
    });
    const second = makeFakeServer([tool("second")], {
      connect: mock(async () => {
        second.connectOrder.push("started");
      }),
    });
    const manager = managerWithClientRoutes(
      {},
      {
        first: makeConfig({ url: "https://first.example.test/rpc" }),
        second: makeConfig({ url: "https://second.example.test/rpc" }),
      },
      { first, second },
    );

    const discovery = manager.discover();
    await Promise.resolve();
    await Promise.resolve();

    expect(second.connectOrder).toEqual(["started"]);
    releaseFirst();

    const result = await discovery;
    expect(result.descriptors.map((descriptor) => descriptor.name).sort()).toEqual([
      "mcp__first__first",
      "mcp__second__second",
    ]);
  });

  test("failed server is skipped and warning redacts secrets", async () => {
    const secret = "Bearer super-secret";
    const failing = makeFakeServer([], {
      connect: mock(async () => {
        throw new Error(`auth failed: ${secret}`);
      }),
    });
    const ok = makeFakeServer([tool("lookup")]);
    const manager = managerWithClientRoutes(
      {},
      {
        failing: makeConfig({
          url: "https://failing.example.test/rpc",
          headers: { Authorization: secret },
        }),
        ok: makeConfig({ url: "https://ok.example.test/rpc" }),
      },
      { failing, ok },
    );

    const result = await manager.discover();

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual([
      "mcp__ok__lookup",
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ serverName: "failing" });
    expect(result.warnings[0].message).toContain(REDACTION_MARKER);
    expect(result.warnings[0].message).not.toContain(secret);
  });

  test("public server URL (no auth headers) is not redacted in error messages", async () => {
    const publicUrl = "https://public.example.test/mcp";
    const failing = makeFakeServer([], {
      connect: mock(async () => {
        throw new Error(`connection refused: ${publicUrl}`);
      }),
    });
    const manager = managerWithClientRoutes(
      {},
      { public: makeConfig({ url: publicUrl }) },
      { public: failing },
    );

    const result = await manager.discover();

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain(publicUrl);
    expect(result.warnings[0].message).not.toContain(REDACTION_MARKER);
  });

  test("server with auth headers has its URL redacted", async () => {
    const authUrl = "https://private.example.test/mcp";
    const secret = "Bearer secret-token";
    const failing = makeFakeServer([], {
      connect: mock(async () => {
        throw new Error(`connection refused: ${authUrl}`);
      }),
    });
    const manager = managerWithClientRoutes(
      {},
      { private: makeConfig({ url: authUrl, headers: { Authorization: secret } }) },
      { private: failing },
    );

    const result = await manager.discover();

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).not.toContain(authUrl);
    expect(result.warnings[0].message).not.toContain(secret);
    expect(result.warnings[0].message).toContain(REDACTION_MARKER);
  });

  test("empty tool list is skipped and warning is recorded", async () => {
    const fake = makeFakeServer([]);
    const manager = new McpManager({}, { empty: makeConfig() }, fake.factories);

    const result = await manager.discover();

    expect(result.descriptors).toEqual([]);
    expect(result.warnings).toEqual([
      {
        serverName: "empty",
        message: 'MCP server "empty" returned no tools',
      },
    ]);
  });

  test("invalid tool name skips only that tool", async () => {
    const fake = makeFakeServer([tool("valid"), tool("bad/name"), tool("also-valid")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const result = await manager.discover();

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual([
      "mcp__docs__valid",
      "mcp__docs__also-valid",
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      serverName: "docs",
      toolName: "bad/name",
    });
  });

  test("duplicate tool names within the same server skip duplicate and warn", async () => {
    const fake = makeFakeServer([
      tool("lookup"),
      { ...tool("lookup"), description: "duplicate" },
      tool("search"),
    ]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const result = await manager.discover();

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual([
      "mcp__docs__lookup",
      "mcp__docs__search",
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      serverName: "docs",
      toolName: "lookup",
    });
    expect(result.warnings[0].message).toContain("Duplicate tool");
  });

  test("continues adapting later tools after an invalid duplicate-like name", async () => {
    const fake = makeFakeServer([
      tool("lookup"),
      tool("bad__name"),
      tool("after"),
    ]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const result = await manager.discover();

    expect(result.descriptors.map((descriptor) => descriptor.name)).toEqual([
      "mcp__docs__lookup",
      "mcp__docs__after",
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      serverName: "docs",
      toolName: "bad__name",
    });
  });
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

describe("McpManager.closeAll", () => {
  test("attempts to close all connected clients", async () => {
    const first = makeFakeServer([tool("first")]);
    const second = makeFakeServer([tool("second")]);
    const manager = managerWithClientRoutes(
      {},
      {
        first: makeConfig({ url: "https://first.example.test/rpc" }),
        second: makeConfig({ url: "https://second.example.test/rpc" }),
      },
      { first, second },
    );

    await manager.discover();
    const warnings = await manager.closeAll();

    expect(warnings).toEqual([]);
    expect(first.sdkClient.close).toHaveBeenCalledTimes(1);
    expect(first.transport.close).toHaveBeenCalledTimes(1);
    expect(second.sdkClient.close).toHaveBeenCalledTimes(1);
    expect(second.transport.close).toHaveBeenCalledTimes(1);
  });

  test("attempts all clients even if one close fails and redacts close warning", async () => {
    const secret = "Bearer close-secret";
    const failing = makeFakeServer([tool("first")], {
      close: mock(async () => {
        throw new Error(`close failed: ${secret}`);
      }),
    });
    const ok = makeFakeServer([tool("second")]);
    const manager = managerWithClientRoutes(
      {},
      {
        failing: makeConfig({
          url: "https://failing.example.test/rpc",
          headers: { Authorization: secret },
        }),
        ok: makeConfig({ url: "https://ok.example.test/rpc" }),
      },
      { failing, ok },
    );

    await manager.discover();
    const warnings = await manager.closeAll();

    expect(failing.sdkClient.close).toHaveBeenCalledTimes(1);
    expect(ok.sdkClient.close).toHaveBeenCalledTimes(1);
    expect(ok.transport.close).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ serverName: "failing" });
    expect(warnings[0].message).toContain(REDACTION_MARKER);
    expect(warnings[0].message).not.toContain(secret);
  });

  test("returns no warnings when no clients were connected", async () => {
    const manager = new McpManager({}, {}, makeFakeServer([]).factories);

    await expect(manager.closeAll()).resolves.toEqual([]);
  });
});
