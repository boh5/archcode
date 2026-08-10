import { describe, expect, mock, test } from "bun:test";
import type { ResolvedMcpServerConfig } from "../config/mcp";
import { createInMemoryLogger, silentLogger } from "../logger";
import { SecretRedactionPolicy } from "../security";
import {
  MAX_MCP_TRANSPORT_BYTES,
  McpClient,
  createDefaultMcpClientFactories,
  createMcpBoundedFetch,
  type McpClientFactories,
  type McpSdkClientLike,
  type McpSdkRequestOptions,
  type McpTransportLike,
} from "./client";
import { McpToolExecutionError } from "./errors";

const HTTP_CONFIG: ResolvedMcpServerConfig = {
  type: "http",
  enabled: true,
  url: "https://mcp.example.test/rpc",
  headers: { Authorization: "secret-value" },
  connectTimeoutMs: 10,
  discoveryTimeoutMs: 20,
  callTimeoutMs: 30,
};

function fakeFactories(
  overrides: Partial<McpSdkClientLike> = {},
  transportOverrides: Partial<McpTransportLike> = {},
): {
  factories: McpClientFactories;
  sdk: McpSdkClientLike;
  transport: McpTransportLike;
} {
  const transport: McpTransportLike = {
    close: mock(async () => undefined),
    ...transportOverrides,
  };
  const sdk: McpSdkClientLike = {
    connect: mock(async () => undefined),
    listTools: mock(async () => ({ tools: [] })),
    callTool: mock(async () => ({ content: [] })),
    close: mock(async () => undefined),
    ...overrides,
  };
  return {
    sdk,
    transport,
    factories: { createClient: () => sdk, createTransport: () => transport },
  };
}

describe("McpClient SDK boundary", () => {
  test("uses independent SDK deadlines and the caller signal", async () => {
    const seen: Array<McpSdkRequestOptions | undefined> = [];
    const fake = fakeFactories({
      connect: mock(async (_transport, options) => { seen.push(options); }),
      listTools: mock(async (_input, options) => { seen.push(options); return { tools: [] }; }),
      callTool: mock(async (_input, _schema, options) => { seen.push(options); return { content: [] }; }),
    });
    const controller = new AbortController();
    const client = new McpClient("docs", HTTP_CONFIG, new SecretRedactionPolicy([]), fake.factories);

    await client.connect(controller.signal);
    await client.listTools(controller.signal);
    await client.callTool("lookup", {}, controller.signal);

    expect(seen.map((value) => value?.timeout)).toEqual([10, 20, 30]);
    expect(seen.map((value) => value?.maxTotalTimeout)).toEqual([10, 20, 30]);
    expect(seen.every((value) => value?.signal === controller.signal)).toBe(true);
  });

  test("paginates tools/list with the remaining discovery deadline", async () => {
    let now = 100;
    const inputs: unknown[] = [];
    const fake = fakeFactories({
      listTools: mock(async (input, options) => {
        inputs.push([input, options?.timeout, options?.maxTotalTimeout]);
        now += 6;
        return input?.cursor
          ? { tools: [{ name: "two" }] }
          : { tools: [{ name: "one" }], nextCursor: "next" };
      }),
    });
    const client = new McpClient(
      "docs",
      HTTP_CONFIG,
      new SecretRedactionPolicy([]),
      fake.factories,
      silentLogger,
      () => now,
    );
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["one", "two"]);
    expect(inputs).toEqual([
      [undefined, 20, 20],
      [{ cursor: "next" }, 14, 14],
    ]);
  });

  test("applies one cumulative discovery deadline across pages", async () => {
    let now = 100;
    const timeouts: number[] = [];
    const fake = fakeFactories({
      listTools: mock(async (input, options) => {
        timeouts.push(options?.timeout ?? -1);
        if (input?.cursor) {
          now += 9;
          return { tools: [{ name: "late" }] };
        }
        now += 12;
        return { tools: [{ name: "one" }], nextCursor: "next" };
      }),
    });
    const client = new McpClient(
      "docs",
      HTTP_CONFIG,
      new SecretRedactionPolicy([]),
      fake.factories,
      silentLogger,
      () => now,
    );

    await expect(client.listTools()).rejects.toEqual(expect.objectContaining({
      reason: "timeout",
    }));
    expect(timeouts).toEqual([20, 8]);
  });

  test("rejects repeated pagination cursors deterministically", async () => {
    const fake = fakeFactories({
      listTools: mock(async (input) => {
        if (input?.cursor === "second") {
          return { tools: [{ name: "three" }], nextCursor: "first" };
        }
        if (input?.cursor === "first") {
          return { tools: [{ name: "two" }], nextCursor: "second" };
        }
        return { tools: [{ name: "one" }], nextCursor: "first" };
      }),
    });
    const client = new McpClient("docs", HTTP_CONFIG, new SecretRedactionPolicy([]), fake.factories);

    await expect(client.listTools()).rejects.toEqual(expect.objectContaining({
      reason: "failed",
      cause: expect.objectContaining({
        message: "MCP tools/list returned a repeated pagination cursor",
      }),
    }));
    expect(fake.sdk.listTools).toHaveBeenCalledTimes(3);
  });

  test("propagates cancellation through paginated discovery", async () => {
    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const fake = fakeFactories({
      listTools: mock(async (input, options) => {
        seenSignals.push(options?.signal);
        if (!input?.cursor) return { tools: [{ name: "one" }], nextCursor: "next" };
        controller.abort();
        options?.signal?.throwIfAborted();
        return { tools: [] };
      }),
    });
    const client = new McpClient("docs", HTTP_CONFIG, new SecretRedactionPolicy([]), fake.factories);

    await expect(client.listTools(controller.signal)).rejects.toEqual(expect.objectContaining({
      reason: "aborted",
    }));
    expect(seenSignals).toEqual([controller.signal, controller.signal]);
  });

  test("rejects an already-aborted call before invoking the SDK", async () => {
    const fake = fakeFactories();
    const client = new McpClient(
      "docs",
      HTTP_CONFIG,
      new SecretRedactionPolicy(["secret-value"]),
      fake.factories,
    );
    const controller = new AbortController();
    controller.abort();
    const error = await client.callTool("lookup-secret-value", {}, controller.signal).catch((cause) => cause);
    expect(error).toMatchObject({ reason: "aborted" });
    expect(String(error)).not.toContain("secret-value");
    expect(fake.sdk.callTool).not.toHaveBeenCalled();
  });

  test("classifies SDK timeout errors without Promise.race", async () => {
    const timeout = Object.assign(new Error("request timed out"), { code: -32001 });
    const fake = fakeFactories({ callTool: mock(async () => { throw timeout; }) });
    const client = new McpClient("docs", HTTP_CONFIG, new SecretRedactionPolicy([]), fake.factories);
    const error = await client.callTool("lookup", {}).catch((cause) => cause);
    expect(error).toEqual(expect.objectContaining({
      reason: "timeout",
    }) as McpToolExecutionError);
    expect(String(error)).toContain("timed out");
  });

  test("redacts configured secrets from wrapped SDK failures", async () => {
    const fake = fakeFactories({ callTool: mock(async () => { throw new Error("secret-value leaked"); }) });
    const client = new McpClient(
      "docs",
      HTTP_CONFIG,
      new SecretRedactionPolicy(["secret-value"]),
      fake.factories,
    );
    await expect(client.callTool("lookup", {})).rejects.toThrow("[REDACTED:SECRET]");
  });

  test("terminates the HTTP session before closing the SDK owner exactly once", async () => {
    const order: string[] = [];
    const fake = fakeFactories(
      { close: mock(async () => { order.push("close"); }) },
      { terminateSession: mock(async () => { order.push("terminate"); }) },
    );
    const client = new McpClient("docs", HTTP_CONFIG, new SecretRedactionPolicy([]), fake.factories);
    await Promise.all([client.close(), client.close()]);
    expect(order).toEqual(["terminate", "close"]);
    expect(fake.transport.terminateSession).toHaveBeenCalledTimes(1);
    expect(fake.sdk.close).toHaveBeenCalledTimes(1);
    expect(fake.transport.close).not.toHaveBeenCalled();
  });

  test("redacts and ignores session termination failures before local close", async () => {
    const { logger, entries } = createInMemoryLogger();
    const failures: string[] = [];
    const terminateError = new Error("secret-value leaked while terminating");
    const fake = fakeFactories({}, {
      terminateSession: mock(async () => {
        fake.transport.onerror?.(terminateError);
        throw terminateError;
      }),
    });
    const client = new McpClient(
      "docs",
      HTTP_CONFIG,
      new SecretRedactionPolicy(["secret-value"]),
      fake.factories,
      logger,
    );
    client.onUnexpectedFailure((error) => failures.push(error.message));

    await expect(client.close()).resolves.toBeUndefined();

    expect(fake.transport.terminateSession).toHaveBeenCalledTimes(1);
    expect(fake.sdk.close).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
    const terminationLog = entries.find((entry) => entry.event === "mcp.client.terminate-session.failed");
    expect(terminationLog).toBeDefined();
    expect(JSON.stringify(terminationLog)).toContain("[REDACTED:SECRET]");
    expect(JSON.stringify(terminationLog)).not.toContain("secret-value");
  });

  test("closes transports without session termination support", async () => {
    const fake = fakeFactories({ close: undefined });
    const client = new McpClient("stdio", HTTP_CONFIG, new SecretRedactionPolicy([]), fake.factories);

    await Promise.all([client.close(), client.close()]);

    expect(fake.transport.terminateSession).toBeUndefined();
    expect(fake.transport.close).toHaveBeenCalledTimes(1);
  });

  test("redacts split secrets and emits at most one UTF-8-safe bounded stderr log", async () => {
    const listeners = new Map<string, Array<(chunk?: unknown) => void>>();
    const stderr = {
      on(event: "data" | "end" | "close", listener: (chunk?: unknown) => void) {
        const current = listeners.get(event) ?? [];
        current.push(listener);
        listeners.set(event, current);
      },
    };
    const emit = (event: "data" | "end" | "close", chunk?: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(chunk);
    };
    const fake = fakeFactories({}, { stderr });
    const { logger, entries } = createInMemoryLogger();
    const client = new McpClient(
      "stdio",
      HTTP_CONFIG,
      new SecretRedactionPolicy(["secret-value"]),
      fake.factories,
      logger,
    );

    emit("data", "before secret-");
    emit("data", `value after ${"x".repeat(4_090)}🙂`);
    emit("data", "dropped forever");
    emit("end");
    await client.close();

    const stderrLogs = entries.filter((entry) => entry.event === "mcp.client.stdio.stderr");
    expect(stderrLogs).toHaveLength(1);
    const output = String(stderrLogs[0]?.context?.output);
    expect(output).toContain("[REDACTED:SECRET]");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("�");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4 * 1024);
  });

  test("reports SDK and transport lifecycle failures but suppresses intentional close", async () => {
    const fake = fakeFactories();
    const client = new McpClient("docs", HTTP_CONFIG, new SecretRedactionPolicy([]), fake.factories);
    const failures: string[] = [];
    client.onUnexpectedFailure((error) => failures.push(error.message));

    fake.sdk.onerror?.(new Error("sdk failed"));
    fake.transport.onclose?.();
    expect(failures).toEqual(["sdk failed", "MCP connection closed unexpectedly"]);

    await client.close();
    fake.sdk.onclose?.();
    fake.transport.onerror?.(new Error("ignored"));
    expect(failures).toEqual(["sdk failed", "MCP connection closed unexpectedly"]);
  });

  test("default factory creates official HTTP and STDIO transports", () => {
    const factory = createDefaultMcpClientFactories();
    const http = factory.createTransport(HTTP_CONFIG);
    const stdio = factory.createTransport({
      type: "stdio",
      enabled: true,
      command: "mcp-server",
      args: ["--stdio"],
      env: { TOKEN: "secret-value" },
      connectTimeoutMs: 10,
      discoveryTimeoutMs: 20,
      callTimeoutMs: 30,
    });
    expect(http.constructor.name).toBe("StreamableHTTPClientTransport");
    expect(stdio.constructor.name).toBe("StdioClientTransport");
  });
});

describe("bounded Streamable HTTP fetch", () => {
  test("rejects an oversized JSON response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(
      new Uint8Array(MAX_MCP_TRANSPORT_BYTES + 1),
      { headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    try {
      const response = await createMcpBoundedFetch()("https://mcp.example.test");
      await expect(response.arrayBuffer()).rejects.toThrow("MCP JSON response exceeded");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
