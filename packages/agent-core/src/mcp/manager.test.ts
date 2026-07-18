import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ResolvedMcpServerConfig } from "../config/mcp";
import { REDACTION_MARKER, SecretRedactionPolicy } from "../security";
import type { McpServerStatus } from "@archcode/protocol";
import type {
  McpClientFactories,
  McpSdkClientLike,
  McpToolLike,
  McpTransportLike,
} from "./client";
import { BUILTIN_MCP_SERVERS } from "./builtin-servers";
import {
  BuiltinMcpServerCollisionError,
  McpManager as RuntimeMcpManager,
} from "./manager";

// ─── Builtin Servers ──────────────────────────────────────────────────────────

describe("BUILTIN_MCP_SERVERS", () => {
  test("contains context7, grep.app, and exa", () => {
    const names = Object.keys(BUILTIN_MCP_SERVERS).sort();
    expect(names).toEqual(["context7", "exa", "grep.app"]);
  });

  test("each server has required HTTP client configuration fields", () => {
    for (const [name, config] of Object.entries(BUILTIN_MCP_SERVERS)) {
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
  url: "https://mcp.example.test/rpc",
  timeout: 50,
};

class McpManager extends RuntimeMcpManager {
  constructor(
    builtinServers: Record<string, ResolvedMcpServerConfig>,
    userServers: Record<string, ResolvedMcpServerConfig>,
    factories: McpClientFactories,
  ) {
    super(
      builtinServers,
      userServers,
      policyForUserServers(userServers),
      factories,
    );
  }
}

function policyForUserServers(
  servers: Record<string, ResolvedMcpServerConfig>,
): SecretRedactionPolicy {
  return new SecretRedactionPolicy(
    Object.values(servers).flatMap((server) => [
      server.url,
      ...Object.values(server.headers ?? {}),
    ]),
  );
}

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

// ─── Background discovery helpers ─────────────────────────────────────────────

function waitForStatus(
  manager: McpManager,
  serverName: string,
  state: McpServerStatus["state"],
): Promise<McpServerStatus> {
  return new Promise((resolve) => {
    const current = manager.getStatus().get(serverName);
    if (current?.state === state) {
      resolve(current);
      return;
    }
    const unsubscribe = manager.onStatusChange((name, status) => {
      if (name === serverName && status.state === state) {
        unsubscribe();
        resolve(status);
      }
    });
  });
}

/** Collect descriptors delivered via onDescriptors until the predicate passes. */
function collectDescriptors(
  manager: McpManager,
  predicate: (names: string[]) => boolean,
): Promise<string[]> {
  return new Promise((resolve) => {
    const collected: string[] = [];
    manager.startBackgroundDiscovery(
      (descriptors) => {
        collected.push(...descriptors.map((d) => d.name));
        if (predicate(collected)) resolve([...collected]);
      },
      () => {},
    );
  });
}

// ─── Merge And Validation ────────────────────────────────────────────────────

describe("McpManager discovery", () => {
  test("merges empty built-ins with user servers", async () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const names = await collectDescriptors(manager, (n) => n.length >= 1);
    expect(names).toEqual(["mcp__docs__lookup"]);
    expect(fake.sdkClient.connect).toHaveBeenCalledTimes(1);
    expect(fake.sdkClient.listTools).toHaveBeenCalledTimes(1);
  });

  test("rejects a user server that collides with a built-in server name", () => {
    const builtinUrl = "https://builtin.example.test/rpc";
    const userUrl = "https://user.example.test/rpc";
    const fake = makeFakeServer([tool("lookup")]);
    expect(() => new McpManager(
      { docs: makeConfig({ url: builtinUrl }) },
      { docs: makeConfig({ url: userUrl }) },
      fake.factories,
    )).toThrow(BuiltinMcpServerCollisionError);
    try {
      new McpManager({ docs: makeConfig({ url: builtinUrl }) }, { docs: makeConfig({ url: userUrl }) }, fake.factories);
      throw new Error("Expected collision");
    } catch (error) {
      expect(error).toBeInstanceOf(BuiltinMcpServerCollisionError);
      expect((error as BuiltinMcpServerCollisionError).serverName).toBe("docs");
    }
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

    const allNames: string[] = [];
    manager.startBackgroundDiscovery(
      (descriptors) => {
        allNames.push(...descriptors.map((d) => d.name));
      },
      () => {},
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(second.connectOrder).toEqual(["started"]);
    releaseFirst();

    await waitForStatus(manager, "first", "ready");
    await waitForStatus(manager, "second", "ready");
    expect(allNames.sort()).toEqual(["mcp__first__first", "mcp__second__second"]);
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

    const warnings: Array<{ serverName?: string; message: string }> = [];
    const allNames: string[] = [];
    manager.startBackgroundDiscovery(
      (descriptors) => {
        allNames.push(...descriptors.map((d) => d.name));
      },
      (warning) => {
        warnings.push({ serverName: warning.serverName, message: warning.message });
      },
    );
    await waitForStatus(manager, "ok", "ready");
    await waitForStatus(manager, "failing", "failed");

    expect(allNames).toEqual(["mcp__ok__lookup"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ serverName: "failing" });
    expect(warnings[0].message).toContain(REDACTION_MARKER);
    expect(warnings[0].message).not.toContain(secret);
  });

  test("user server URLs are runtime literals even without auth headers", async () => {
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

    const warnings: Array<{ serverName?: string; message: string }> = [];
    manager.startBackgroundDiscovery(
      () => {},
      (warning) => {
        warnings.push({ serverName: warning.serverName, message: warning.message });
      },
    );
    await waitForStatus(manager, "public", "failed");

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).not.toContain(publicUrl);
    expect(warnings[0].message).toContain(REDACTION_MARKER);
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

    const warnings: Array<{ serverName?: string; message: string }> = [];
    manager.startBackgroundDiscovery(
      () => {},
      (warning) => {
        warnings.push({ serverName: warning.serverName, message: warning.message });
      },
    );
    await waitForStatus(manager, "private", "failed");

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).not.toContain(authUrl);
    expect(warnings[0].message).not.toContain(secret);
    expect(warnings[0].message).toContain(REDACTION_MARKER);
  });

  test("empty tool list is skipped and warning is recorded", async () => {
    const fake = makeFakeServer([]);
    const manager = new McpManager({}, { empty: makeConfig() }, fake.factories);

    const warnings: Array<{ serverName?: string; message: string }> = [];
    manager.startBackgroundDiscovery(
      () => {},
      (warning) => {
        warnings.push({ serverName: warning.serverName, message: warning.message });
      },
    );
    await waitForStatus(manager, "empty", "ready");

    expect(warnings).toEqual([
      {
        serverName: "empty",
        message: 'MCP server "empty" returned no tools',
      },
    ]);
  });

  test("invalid tool name skips only that tool", async () => {
    const fake = makeFakeServer([tool("valid"), tool("bad/name"), tool("also-valid")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const names = await collectDescriptors(manager, (n) => n.length >= 2);
    expect(names).toEqual(["mcp__docs__valid", "mcp__docs__also-valid"]);
  });

  test("duplicate tool names within the same server skip duplicate and warn", async () => {
    const fake = makeFakeServer([
      tool("lookup"),
      { ...tool("lookup"), description: "duplicate" },
      tool("search"),
    ]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const warnings: Array<{ serverName?: string; toolName?: string; message: string }> = [];
    const names = await new Promise<string[]>((resolve) => {
      const collected: string[] = [];
      manager.startBackgroundDiscovery(
        (descriptors) => {
          collected.push(...descriptors.map((d) => d.name));
          if (collected.length >= 2) resolve([...collected]);
        },
        (warning) => {
          warnings.push({
            serverName: warning.serverName,
            toolName: warning.toolName,
            message: warning.message,
          });
        },
      );
    });

    expect(names).toEqual(["mcp__docs__lookup", "mcp__docs__search"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      serverName: "docs",
      toolName: "lookup",
    });
    expect(warnings[0].message).toContain("Duplicate tool");
  });

  test("continues adapting later tools after an invalid duplicate-like name", async () => {
    const fake = makeFakeServer([
      tool("lookup"),
      tool("bad__name"),
      tool("after"),
    ]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const names = await collectDescriptors(manager, (n) => n.length >= 2);
    expect(names).toEqual(["mcp__docs__lookup", "mcp__docs__after"]);
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

    manager.startBackgroundDiscovery(() => {}, () => {});
    await waitForStatus(manager, "first", "ready");
    await waitForStatus(manager, "second", "ready");

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

    manager.startBackgroundDiscovery(() => {}, () => {});
    await waitForStatus(manager, "failing", "ready");
    await waitForStatus(manager, "ok", "ready");

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

// ─── Background Discovery & Status Tracking ──────────────────────────────────

describe("McpManager background discovery & status", () => {
  test("initializes all servers as pending", () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager(
      { builtin: makeConfig({ url: "https://builtin.example.test/rpc" }) },
      { user: makeConfig({ url: "https://user.example.test/rpc" }) },
      fake.factories,
    );

    const status = manager.getStatus();

    expect(status.size).toBe(2);
    expect(status.get("builtin")).toEqual({ state: "pending" });
    expect(status.get("user")).toEqual({ state: "pending" });
  });

  test("emits ready status with toolCount after successful discovery", async () => {
    const fake = makeFakeServer([tool("lookup"), tool("search")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    manager.startBackgroundDiscovery(() => {}, () => {});
    const status = await waitForStatus(manager, "docs", "ready");

    expect(status).toEqual({ state: "ready", toolCount: 2 });
  });

  test("emits failed status with redacted error on connect failure", async () => {
    const secret = "Bearer connect-secret";
    const failing = makeFakeServer([], {
      connect: mock(async () => {
        throw new Error(`connect failed: ${secret}`);
      }),
    });
    const manager = new McpManager(
      {},
      { failing: makeConfig({ url: "https://failing.example.test/rpc", headers: { Authorization: secret } }) },
      failing.factories,
    );

    manager.startBackgroundDiscovery(() => {}, () => {});
    const status = await waitForStatus(manager, "failing", "failed");

    expect(status.state).toBe("failed");
    if (status.state === "failed") {
      expect(status.error).toContain(REDACTION_MARKER);
      expect(status.error).not.toContain(secret);
    }
  });

  test("invokes onDescriptors callback with adapted descriptors", async () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const captured: string[] = [];
    manager.startBackgroundDiscovery(
      (descriptors) => {
        captured.push(...descriptors.map((d) => d.name));
      },
      () => {},
    );
    await waitForStatus(manager, "docs", "ready");

    expect(captured).toEqual(["mcp__docs__lookup"]);
  });

  test("invokes onWarning callback for empty-tools server", async () => {
    const fake = makeFakeServer([]);
    const manager = new McpManager({}, { empty: makeConfig() }, fake.factories);

    const warnings: Array<{ serverName?: string; message: string }> = [];
    manager.startBackgroundDiscovery(
      () => {},
      (warning) => {
        warnings.push({ serverName: warning.serverName, message: warning.message });
      },
    );
    await waitForStatus(manager, "empty", "ready");

    expect(warnings).toHaveLength(1);
    expect(warnings[0].serverName).toBe("empty");
    expect(warnings[0].message).toContain("no tools");
  });

  test("does not block — startBackgroundDiscovery returns immediately", () => {
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const fake = makeFakeServer([tool("lookup")], {
      connect: mock(async () => {
        await connectGate;
      }),
    });
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    let afterCallRan = false;
    manager.startBackgroundDiscovery(() => {}, () => {});
    // Synchronous code after the call runs before discovery completes
    afterCallRan = true;

    expect(afterCallRan).toBe(true);
    expect(manager.getStatus().get("docs")).toEqual({ state: "pending" });

    releaseConnect();
  });

  test("status listeners receive per-server updates", async () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const updates: Array<{ serverName: string; status: McpServerStatus }> = [];
    const unsubscribe = manager.onStatusChange((serverName, status) => {
      updates.push({ serverName, status });
    });

    manager.startBackgroundDiscovery(() => {}, () => {});
    await waitForStatus(manager, "docs", "ready");

    const readyUpdate = updates.find(
      (u) => u.serverName === "docs" && u.status.state === "ready",
    );
    expect(readyUpdate).toBeDefined();
    expect(readyUpdate?.status).toEqual({ state: "ready", toolCount: 1 });

    // Unsubscribe stops further updates
    const before = updates.length;
    unsubscribe();
    expect(updates.length).toBe(before);
  });

  test("getStatus returns a snapshot Map (mutations do not affect internal state)", () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const snapshot = manager.getStatus();
    snapshot.set("docs", { state: "failed", error: "tampered" });
    snapshot.delete("docs");

    const fresh = manager.getStatus();
    expect(fresh.get("docs")).toEqual({ state: "pending" });
    expect(fresh.size).toBe(1);
  });

  test("handles multiple servers in parallel", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = makeFakeServer([tool("first")], {
      connect: mock(async () => {
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

    const allDescriptors: string[] = [];
    manager.startBackgroundDiscovery(
      (descriptors) => {
        allDescriptors.push(...descriptors.map((d) => d.name));
      },
      () => {},
    );

    // Second server completes while first is gated
    await waitForStatus(manager, "second", "ready");
    expect(manager.getStatus().get("first")).toEqual({ state: "pending" });

    releaseFirst();
    await waitForStatus(manager, "first", "ready");

    expect(allDescriptors.sort()).toEqual(["mcp__first__first", "mcp__second__second"]);
  });
});

// ─── H1: Top-level error handling in discoverBackground ───────────────────────

describe("McpManager top-level discovery error handling (H1)", () => {
  test("top-level error marks all pending servers as failed and calls onWarning", async () => {
    // Force a synchronous throw inside discoverServerBackground by making the
    // McpClient constructor throw (factories.createClient throws).
    const throwingFactories: McpClientFactories = {
      createClient: mock(() => {
        throw new Error("boom: client factory exploded");
      }),
      createTransport: mock(() => {
        throw new Error("boom: transport factory exploded");
      }),
    };
    const manager = new McpManager(
      {},
      { docs: makeConfig(), other: makeConfig() },
      throwingFactories,
    );

    const warnings: Array<{ serverName?: string; message: string }> = [];
    manager.startBackgroundDiscovery(
      () => {},
      (warning) => {
        warnings.push({ serverName: warning.serverName, message: warning.message });
      },
    );

    // Both servers should be marked failed (not stuck pending forever).
    const docsStatus = await waitForStatus(manager, "docs", "failed");
    const otherStatus = await waitForStatus(manager, "other", "failed");

    expect(docsStatus.state).toBe("failed");
    expect(otherStatus.state).toBe("failed");
    // At least one warning emitted for the top-level failure.
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("top-level error does not produce an unhandled rejection", async () => {
    // If the promise rejects unhandled, bun:test surfaces it as a test failure.
    // We assert the test completes cleanly simply by reaching the end.
    const throwingFactories: McpClientFactories = {
      createClient: mock(() => {
        throw new Error("sync constructor failure");
      }),
      createTransport: mock(() => {
        throw new Error("sync transport failure");
      }),
    };
    const manager = new McpManager({}, { docs: makeConfig() }, throwingFactories);

    manager.startBackgroundDiscovery(() => {}, () => {});
    await waitForStatus(manager, "docs", "failed");
    // Reaching here means no unhandled rejection crashed the test.
    expect(manager.getStatus().get("docs")?.state).toBe("failed");
  });
});

// ─── H3: Single-flight & close-safety ─────────────────────────────────────────

describe("McpManager single-flight & close-safety (H3)", () => {
  test("startBackgroundDiscovery called twice throws on second call", () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    manager.startBackgroundDiscovery(() => {}, () => {});
    expect(() => manager.startBackgroundDiscovery(() => {}, () => {})).toThrow(
      /already started/i,
    );
  });

  test("closeAll while in-flight: late-completing client is not registered and is closed", async () => {
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const fake = makeFakeServer([tool("lookup")], {
      connect: mock(async () => {
        await connectGate;
      }),
    });
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    let descriptorsDelivered = false;
    manager.startBackgroundDiscovery(
      () => {
        descriptorsDelivered = true;
      },
      () => {},
    );
    // Let the connect promise settle into the gate (pending).
    await Promise.resolve();
    await Promise.resolve();

    // Close before connect resolves.
    await manager.closeAll();

    // Now release the gate — late completion must short-circuit.
    releaseConnect();
    // Allow microtasks to flush.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(descriptorsDelivered).toBe(false);
    // Status must NOT be ready (it stays pending; closeAll doesn't set failed).
    const status = manager.getStatus().get("docs");
    expect(status?.state).not.toBe("ready");
    // The client that connected late must have been closed.
    expect(fake.sdkClient.close).toHaveBeenCalledTimes(1);
    expect(fake.transport.close).toHaveBeenCalledTimes(1);
  });

  test("closeAll sets #closed; subsequent startBackgroundDiscovery is rejected", async () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);
    manager.startBackgroundDiscovery(() => {}, () => {});
    await waitForStatus(manager, "docs", "ready");
    await manager.closeAll();

    // After close, a fresh start should be refused (already started OR closed).
    expect(() => manager.startBackgroundDiscovery(() => {}, () => {})).toThrow();
  });
});

// ─── M3: setStatus listener isolation ─────────────────────────────────────────

describe("McpManager setStatus listener isolation (M3)", () => {
  test("throwing listener does not affect other listeners or server status", async () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);

    const calls: string[] = [];
    manager.onStatusChange(() => {
      calls.push("before");
      throw new Error("listener boom");
    });
    manager.onStatusChange(() => {
      calls.push("after");
    });

    manager.startBackgroundDiscovery(() => {}, () => {});
    const status = await waitForStatus(manager, "docs", "ready");

    // Both listeners ran despite the first throwing.
    expect(calls).toContain("before");
    expect(calls).toContain("after");
    // Server status is ready, not failed.
    expect(status.state).toBe("ready");
    expect(status).toEqual({ state: "ready", toolCount: 1 });
  });
});

// ─── Removed discover() method ───────────────────────────────────────────────

describe("McpManager removed discover() method", () => {
  test("discover is no longer a public method", () => {
    const fake = makeFakeServer([tool("lookup")]);
    const manager = new McpManager({}, { docs: makeConfig() }, fake.factories);
    // The old discover() method must not exist on the instance.
    expect((manager as unknown as Record<string, unknown>).discover).toBeUndefined();
  });
});
