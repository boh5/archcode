import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ResolvedMcpServerConfig } from "../config/mcp";
import { REDACTION_MARKER } from "../tools/hooks/redact";
import {
  McpClient,
  type CallToolResultLike,
  type McpClientFactories,
  type McpSdkClientLike,
  type McpTransportLike,
} from "./client";
import { McpConnectionError, McpToolExecutionError } from "./errors";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_CONFIG: ResolvedMcpServerConfig = {
  transport: "http",
  url: "https://mcp.example.test/rpc",
  timeout: 50,
};

type FakeFactories = McpClientFactories & {
  sdkClient: McpSdkClientLike;
  transport: McpTransportLike;
  createdTransports: Array<{
    url: URL;
    options: { headers?: Record<string, string> };
  }>;
};

function makeResult(text: string): CallToolResultLike {
  return { content: [{ type: "text", text }] };
}

function makeFakeFactories(
  overrides: Partial<McpSdkClientLike> = {},
  transportOverrides: Partial<McpTransportLike> = {},
): FakeFactories {
  const sdkClient: McpSdkClientLike = {
    connect: mock(async () => {}),
    listTools: mock(async () => ({ tools: [] })),
    callTool: mock(async () => makeResult("ok")),
    close: mock(async () => {}),
    ...overrides,
  };

  const transport: McpTransportLike = {
    close: mock(async () => {}),
    ...transportOverrides,
  };

  const createdTransports: FakeFactories["createdTransports"] = [];

  return {
    sdkClient,
    transport,
    createdTransports,
    createClient: mock(() => sdkClient),
    createTransport: mock(
      (url: URL, options: { headers?: Record<string, string> }) => {
        createdTransports.push({ url, options });
        return transport;
      },
    ),
  };
}

function pendingPromise<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

afterEach(() => {
  mock.restore();
});

// ─── Construction ────────────────────────────────────────────────────────────

describe("McpClient construction", () => {
  test("constructs HTTP transport with configured URL", async () => {
    const factories = makeFakeFactories();
    const client = new McpClient("context7", BASE_CONFIG, factories);

    await client.connect();

    expect(factories.createClient).toHaveBeenCalledTimes(1);
    expect(factories.createTransport).toHaveBeenCalledTimes(1);
    expect(factories.createdTransports[0].url.href).toBe(BASE_CONFIG.url);
    expect(factories.sdkClient.connect).toHaveBeenCalledWith(factories.transport);
  });

  test("accepts injected fake SDK factories", async () => {
    const expected = makeResult("from fake");
    const factories = makeFakeFactories({
      callTool: mock(async () => expected),
    });
    const client = new McpClient("context7", BASE_CONFIG, factories);

    await client.connect();
    const actual = await client.callTool("resolve-library-id", { q: "react" });

    expect(actual).toBe(expected);
    expect(factories.createClient).toHaveBeenCalledTimes(1);
    expect(factories.createTransport).toHaveBeenCalledTimes(1);
  });

  test("passes configured headers through transport options", async () => {
    const headers = { Authorization: "Bearer secret-token", "X-Team": "agent" };
    const factories = makeFakeFactories();
    const client = new McpClient(
      "context7",
      { ...BASE_CONFIG, headers },
      factories,
    );

    await client.connect();

    expect(factories.createdTransports[0].options.headers).toEqual(headers);
  });
});

// ─── Tool Listing ────────────────────────────────────────────────────────────

describe("McpClient.listTools", () => {
  test("follows nextCursor until exhausted", async () => {
    const listTools = mock(async (input?: { cursor?: string }) => {
      if (!input?.cursor) {
        return {
          tools: [{ name: "first", inputSchema: { type: "object" } }],
          nextCursor: "page-2",
        };
      }

      return {
        tools: [{ name: "second", description: "Second tool" }],
      };
    });
    const factories = makeFakeFactories({ listTools });
    const client = new McpClient("context7", BASE_CONFIG, factories);

    const tools = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(listTools).toHaveBeenNthCalledWith(1, undefined);
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: "page-2" });
  });
});

// ─── Tool Calls ──────────────────────────────────────────────────────────────

describe("McpClient.callTool", () => {
  test("calls SDK with original MCP tool name", async () => {
    const callTool = mock(async () => makeResult("called"));
    const factories = makeFakeFactories({ callTool });
    const client = new McpClient("context7", BASE_CONFIG, factories);

    await client.callTool("resolve-library-id", { libraryName: "React" });

    expect(callTool).toHaveBeenCalledWith({
      name: "resolve-library-id",
      arguments: { libraryName: "React" },
    });
  });
});

// ─── Timeouts And Redaction ─────────────────────────────────────────────────

describe("McpClient timeouts", () => {
  test("timeout on connect produces named MCP connection error", async () => {
    const factories = makeFakeFactories({
      connect: mock(() => pendingPromise<void>()),
    });
    const client = new McpClient(
      "context7",
      { ...BASE_CONFIG, timeout: 1 },
      factories,
    );

    await expect(client.connect()).rejects.toThrow(McpConnectionError);
    await expect(client.connect()).rejects.toHaveProperty(
      "name",
      "McpConnectionError",
    );
  });

  test("timeout on listTools produces named MCP connection error", async () => {
    const factories = makeFakeFactories({
      listTools: mock(() => pendingPromise<{ tools: unknown[] }>()),
    });
    const client = new McpClient(
      "context7",
      { ...BASE_CONFIG, timeout: 1 },
      factories,
    );

    await expect(client.listTools()).rejects.toThrow(McpConnectionError);
    await expect(client.listTools()).rejects.toHaveProperty(
      "name",
      "McpConnectionError",
    );
  });

  test("timeout on callTool produces named MCP tool execution error", async () => {
    const factories = makeFakeFactories({
      callTool: mock(() => pendingPromise<CallToolResultLike>()),
    });
    const client = new McpClient(
      "context7",
      { ...BASE_CONFIG, timeout: 1 },
      factories,
    );

    await expect(client.callTool("read-secret", {})).rejects.toThrow(
      McpToolExecutionError,
    );
    await expect(client.callTool("read-secret", {})).rejects.toHaveProperty(
      "name",
      "McpToolExecutionError",
    );
  });

  test("timeout helper clears timers without waiting for configured default", async () => {
    const originalClearTimeout = globalThis.clearTimeout;
    const clearTimeoutSpy = mock((handle?: Timer | number) =>
      originalClearTimeout(handle),
    );
    globalThis.clearTimeout =
      clearTimeoutSpy as unknown as typeof globalThis.clearTimeout;

    try {
      const factories = makeFakeFactories({
        listTools: mock(async () => ({ tools: [] })),
      });
      const client = new McpClient(
        "context7",
        { ...BASE_CONFIG, timeout: 30_000 },
        factories,
      );

      await client.listTools();

      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("timeout helper clears timers after timeout rejection", async () => {
    const originalClearTimeout = globalThis.clearTimeout;
    const clearTimeoutSpy = mock((handle?: Timer | number) =>
      originalClearTimeout(handle),
    );
    globalThis.clearTimeout =
      clearTimeoutSpy as unknown as typeof globalThis.clearTimeout;

    try {
      const factories = makeFakeFactories({
        connect: mock(() => pendingPromise<void>()),
      });
      const client = new McpClient(
        "context7",
        { ...BASE_CONFIG, timeout: 1 },
        factories,
      );

      await expect(client.connect()).rejects.toThrow(McpConnectionError);

      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("headers are redacted from connection errors", async () => {
    const factories = makeFakeFactories({
      connect: mock(async () => {
        throw new Error("bad auth: Bearer secret-token");
      }),
    });
    const client = new McpClient(
      "context7",
      {
        ...BASE_CONFIG,
        headers: { Authorization: "Bearer secret-token" },
      },
      factories,
    );

    try {
      await client.connect();
      throw new Error("expected connect to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(McpConnectionError);
      expect((err as Error).message).toContain(REDACTION_MARKER);
      expect((err as Error).message).not.toContain("secret-token");
    }
  });

  test("headers are redacted from tool execution errors", async () => {
    const factories = makeFakeFactories({
      callTool: mock(async () => {
        throw new Error("server echoed api-key-123");
      }),
    });
    const client = new McpClient(
      "context7",
      {
        ...BASE_CONFIG,
        headers: { "X-API-Key": "api-key-123" },
      },
      factories,
    );

    try {
      await client.callTool("fetch", {});
      throw new Error("expected callTool to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(McpToolExecutionError);
      expect((err as Error).message).toContain(REDACTION_MARKER);
      expect((err as Error).message).not.toContain("api-key-123");
    }
  });

  test("string causes do not expose header secrets on public error fields", async () => {
    const factories = makeFakeFactories({
      connect: mock(async () => {
        throw "secret-token";
      }),
    });
    const client = new McpClient(
      "context7",
      {
        ...BASE_CONFIG,
        headers: { Authorization: "secret-token" },
      },
      factories,
    );

    try {
      await client.connect();
      throw new Error("expected connect to fail");
    } catch (err) {
      const connectionError = err as McpConnectionError;
      expect(connectionError.cause).toBeInstanceOf(Error);
      expect(String(connectionError.cause)).toContain(REDACTION_MARKER);
      expect(String(connectionError.cause)).not.toContain("secret-token");
    }
  });
});

// ─── Closing ─────────────────────────────────────────────────────────────────

describe("McpClient.close", () => {
  test("closes SDK client and transport when exposed", async () => {
    const factories = makeFakeFactories();
    const client = new McpClient("context7", BASE_CONFIG, factories);

    await client.connect();
    await client.close();

    expect(factories.sdkClient.close).toHaveBeenCalledTimes(1);
    expect(factories.transport.close).toHaveBeenCalledTimes(1);
  });

  test("handles missing close capabilities safely", async () => {
    const factories = makeFakeFactories(
      { close: undefined },
      { close: undefined },
    );
    const client = new McpClient("context7", BASE_CONFIG, factories);

    await client.connect();

    await expect(client.close()).resolves.toBeUndefined();
  });

  test("can close safely before connecting", async () => {
    const factories = makeFakeFactories();
    const client = new McpClient("context7", BASE_CONFIG, factories);

    await expect(client.close()).resolves.toBeUndefined();

    expect(factories.sdkClient.close).toHaveBeenCalledTimes(1);
    expect(factories.transport.close).toHaveBeenCalledTimes(1);
  });
});
