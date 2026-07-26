import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ResolvedMcpServerConfig } from "../config/mcp";
import { silentLogger } from "../logger";
import { REDACTION_MARKER, SecretRedactionPolicy } from "../security";
import {
  MAX_MCP_TRANSPORT_BYTES,
  McpClient,
  createMcpBoundedFetch,
  type CallToolResultLike,
  type McpDeadlineHandle,
  type McpDeadlineScheduler,
  type McpClientFactories,
  type McpSdkClientLike,
  type McpTransportLike,
} from "./client";
import { McpConnectionError, McpToolExecutionError } from "./errors";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_CONFIG: ResolvedMcpServerConfig = {
  url: "https://mcp.example.test/rpc",
  timeout: 50,
};
const TEST_REDACTION_POLICY = new SecretRedactionPolicy([
  "secret-token",
  "api-key-123",
]);

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

interface ManualMcpDeadlineScheduler extends McpDeadlineScheduler {
  readonly cancelCount: () => number;
  readonly pendingCount: () => number;
  fireScheduled(): void;
}

function createManualMcpDeadlineScheduler(): ManualMcpDeadlineScheduler {
  let nextId = 1;
  let cancelled = 0;
  const scheduled = new Map<number, () => void>();
  return {
    schedule: (_delayMs, callback) => {
      const id = nextId++;
      scheduled.set(id, callback);
      return { id };
    },
    cancel: (handle: McpDeadlineHandle) => {
      cancelled += 1;
      if (typeof handle.id === "number") scheduled.delete(handle.id);
    },
    cancelCount: () => cancelled,
    pendingCount: () => scheduled.size,
    fireScheduled: () => {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function pendingPromise<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

afterEach(() => {
  mock.restore();
});

describe("createMcpBoundedFetch", () => {
  test("accepts JSON and a complete SSE event exactly at the 8 MiB boundary", async () => {
    const json = await withMockedFetchResponse(
      [new Uint8Array(MAX_MCP_TRANSPORT_BYTES).fill(0x61)],
      "application/json",
      (bounded) => bounded.arrayBuffer(),
    );
    expect(json.byteLength).toBe(MAX_MCP_TRANSPORT_BYTES);

    const prefix = new TextEncoder().encode("data: ");
    const delimiter = new TextEncoder().encode("\n\n");
    const payload = new Uint8Array(MAX_MCP_TRANSPORT_BYTES - prefix.byteLength - delimiter.byteLength).fill(0x61);
    const event = await withMockedFetchResponse(
      [prefix, payload, delimiter],
      "text/event-stream",
      (bounded) => bounded.arrayBuffer(),
    );
    expect(event.byteLength).toBe(MAX_MCP_TRANSPORT_BYTES);
  });

  test("enforces the JSON cap before a downstream parser sees the body", async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = 0;
    globalThis.fetch = mock(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MCP_TRANSPORT_BYTES));
        controller.enqueue(Uint8Array.of(0x7d));
      },
      cancel() { cancelled += 1; },
    }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    try {
      const response = await createMcpBoundedFetch()("https://mcp.example.test");
      await expect(response.arrayBuffer()).rejects.toThrow("MCP JSON response exceeded");
      expect(cancelled).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("accepts multiple long-lived SSE events whose aggregate exceeds 8 MiB", async () => {
    const first = new TextEncoder().encode(`data: ${"a".repeat(4 * 1024 * 1024 - 16)}\n\n`);
    const second = new TextEncoder().encode(`id: repeated\n: keepalive\ndata: ${"b".repeat(4 * 1024 * 1024 - 16)}\n\n`);
    const response = await withMockedFetchResponse(
      [first, second],
      "text/event-stream",
      (bounded) => bounded,
    );
    expect((await response.arrayBuffer()).byteLength).toBe(first.byteLength + second.byteLength);
    expect(first.byteLength + second.byteLength).toBeGreaterThan(MAX_MCP_TRANSPORT_BYTES);
  });

  test("counts comments, repeated id fields, and data as one bounded SSE event", async () => {
    const prefix = new TextEncoder().encode(": comment\nid: one\nid: two\ndata: ");
    const oversized = new Uint8Array(MAX_MCP_TRANSPORT_BYTES - prefix.byteLength + 1);
    oversized.fill(0x61);
    const response = await withMockedFetchResponse(
      [prefix, oversized, new TextEncoder().encode("\n\n")],
      "text/event-stream",
      (bounded) => bounded,
    );
    await expect(response.text()).rejects.toThrow("MCP SSE event exceeded");
  });

  test("handles CR-only and split CRLF delimiters without merging adjacent events", async () => {
    const chunks = [
      new TextEncoder().encode("id: one\rdata: first\r\r: comment\rdata: second\r"),
      new TextEncoder().encode("\n\r"),
      new TextEncoder().encode("\n"),
    ];
    const response = await withMockedFetchResponse(chunks, "text/event-stream", (bounded) => bounded);
    expect(await response.text()).toBe("id: one\rdata: first\r\r: comment\rdata: second\r\n\r\n");
  });

  test("rejects a single SSE line before it can grow beyond the cap", async () => {
    const response = await withMockedFetchResponse(
      [new Uint8Array(MAX_MCP_TRANSPORT_BYTES + 1).fill(0x61)],
      "text/event-stream",
      (bounded) => bounded,
    );
    await expect(response.text()).rejects.toThrow(/MCP SSE (?:line|event) exceeded/);
  });
});

async function withMockedFetchResponse<T>(
  chunks: readonly Uint8Array[],
  contentType: string,
  use: (response: Response) => T | Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "content-type": contentType } })) as unknown as typeof fetch;
  try {
    return await use(await createMcpBoundedFetch()("https://mcp.example.test"));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ─── Construction ────────────────────────────────────────────────────────────

describe("McpClient construction", () => {
  test("constructs HTTP transport with configured URL", async () => {
    const factories = makeFakeFactories();
    const client = new McpClient("context7", BASE_CONFIG, TEST_REDACTION_POLICY, factories);

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
    const client = new McpClient("context7", BASE_CONFIG, TEST_REDACTION_POLICY, factories);

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
      TEST_REDACTION_POLICY,
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
    const client = new McpClient("context7", BASE_CONFIG, TEST_REDACTION_POLICY, factories);

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
    const client = new McpClient("context7", BASE_CONFIG, TEST_REDACTION_POLICY, factories);

    await client.callTool("resolve-library-id", { libraryName: "React" });

    expect(callTool).toHaveBeenCalledWith({
      name: "resolve-library-id",
      arguments: { libraryName: "React" },
    });
  });
});

// ─── Timeouts ───────────────────────────────────────────────────────────────

describe("McpClient timeouts", () => {
  test.each([
    {
      operation: "connect",
      factories: () => makeFakeFactories({ connect: mock(() => pendingPromise<void>()) }),
      invoke: (client: McpClient) => client.connect(),
      errorName: "McpConnectionError",
    },
    {
      operation: "tools/list",
      factories: () => makeFakeFactories({ listTools: mock(() => pendingPromise<{ tools: unknown[] }>()) }),
      invoke: (client: McpClient) => client.listTools(),
      errorName: "McpConnectionError",
    },
    {
      operation: "tools/call",
      factories: () => makeFakeFactories({ callTool: mock(() => pendingPromise<CallToolResultLike>()) }),
      invoke: (client: McpClient) => client.callTool("read-secret", {}),
      errorName: "McpToolExecutionError",
    },
  ])("maps a manually triggered $operation deadline and cancels its timer", async ({ factories, invoke, errorName }) => {
    const deadlineScheduler = createManualMcpDeadlineScheduler();
    const client = new McpClient(
      "context7",
      { ...BASE_CONFIG, timeout: 30_000 },
      TEST_REDACTION_POLICY,
      factories(),
      silentLogger,
      deadlineScheduler,
    );

    const operation = invoke(client);
    expect(deadlineScheduler.pendingCount()).toBe(1);
    deadlineScheduler.fireScheduled();

    await expect(operation).rejects.toHaveProperty("name", errorName);
    expect(deadlineScheduler.cancelCount()).toBe(1);
    expect(deadlineScheduler.pendingCount()).toBe(0);
  });

  test("cancels the deadline when an operation settles first", async () => {
    const deadlineScheduler = createManualMcpDeadlineScheduler();
    const client = new McpClient(
      "context7",
      BASE_CONFIG,
      TEST_REDACTION_POLICY,
      makeFakeFactories(),
      silentLogger,
      deadlineScheduler,
    );

    await client.listTools();

    expect(deadlineScheduler.cancelCount()).toBe(1);
    expect(deadlineScheduler.pendingCount()).toBe(0);
  });
});

// ─── Redaction ──────────────────────────────────────────────────────────────

describe("McpClient redaction", () => {
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
      TEST_REDACTION_POLICY,
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
      TEST_REDACTION_POLICY,
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
      TEST_REDACTION_POLICY,
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
    const client = new McpClient("context7", BASE_CONFIG, TEST_REDACTION_POLICY, factories);

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
    const client = new McpClient("context7", BASE_CONFIG, TEST_REDACTION_POLICY, factories);

    await client.connect();

    await expect(client.close()).resolves.toBeUndefined();
  });

  test("can close safely before connecting", async () => {
    const factories = makeFakeFactories();
    const client = new McpClient("context7", BASE_CONFIG, TEST_REDACTION_POLICY, factories);

    await expect(client.close()).resolves.toBeUndefined();

    expect(factories.sdkClient.close).toHaveBeenCalledTimes(1);
    expect(factories.transport.close).toHaveBeenCalledTimes(1);
  });
});
