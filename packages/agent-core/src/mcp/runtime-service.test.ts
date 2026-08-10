import { describe, expect, mock, test } from "bun:test";
import type { ResolvedMcpConfig, ResolvedMcpServerConfig } from "../config/mcp";
import type { RawToolResult, ToolExecutionContext } from "../tools/types";
import type {
  CallToolResultLike,
  McpClientFactories,
  McpSdkClientLike,
  McpTransportLike,
} from "./client";
import { MAX_CONCURRENT_MCP_DRAFT_TESTS, McpRuntimeService } from "./runtime-service";

const HTTP = (url: string, headers?: Record<string, string>): ResolvedMcpServerConfig => ({
  type: "http",
  enabled: true,
  url,
  ...(headers ? { headers } : {}),
  connectTimeoutMs: 10,
  discoveryTimeoutMs: 20,
  callTimeoutMs: 30,
});

const STDIO = (command: string, env?: Record<string, string>): ResolvedMcpServerConfig => ({
  type: "stdio",
  enabled: true,
  command,
  args: [],
  ...(env ? { env } : {}),
  connectTimeoutMs: 10,
  discoveryTimeoutMs: 20,
  callTimeoutMs: 30,
});

const CONFIG = (servers: ResolvedMcpConfig["servers"], disabledBuiltins: ResolvedMcpConfig["disabledBuiltins"] = []): ResolvedMcpConfig => ({
  disabledBuiltins,
  servers,
});

function sdk(options: {
  connect?: McpSdkClientLike["connect"];
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: { readOnlyHint?: boolean };
  }>;
  call?: (input: { name: string; arguments: Record<string, unknown> }) => Promise<CallToolResultLike>;
} = {}): McpSdkClientLike & { close: ReturnType<typeof mock> } {
  return {
    connect: mock(options.connect ?? (async () => undefined)),
    listTools: mock(async () => ({ tools: options.tools ?? [{ name: "lookup" }] })),
    callTool: mock(async (input) => options.call?.(input) ?? { content: [{ type: "text", text: input.name }] }),
    close: mock(async () => undefined),
  };
}

function serviceWith(clients: McpSdkClientLike[], options: {
  builtins?: Record<string, ResolvedMcpServerConfig>;
  now?: () => number;
  transports?: McpTransportLike[];
} = {}): McpRuntimeService {
  const queue = [...clients];
  const transports = [...(options.transports ?? [])];
  const factories: McpClientFactories = {
    createClient: () => {
      const client = queue.shift();
      if (!client) throw new Error("No fake MCP client remaining");
      return client;
    },
    createTransport: () => transports.shift() ?? ({} as McpTransportLike),
  };
  return new McpRuntimeService({
    builtinServers: options.builtins ?? {},
    clientFactories: factories,
    now: options.now,
  });
}

async function execute(descriptor: { execute: (input: Record<string, unknown>, context: ToolExecutionContext) => unknown }): Promise<RawToolResult> {
  return await descriptor.execute({}, { abort: new AbortController().signal } as ToolExecutionContext) as RawToolResult;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("McpRuntimeService", () => {
  test("snapshots every user server and only the requested builtins with matching status", async () => {
    let clock = 100;
    const runtime = serviceWith(
      [sdk({ tools: [{ name: "builtin-read" }] }), sdk({ tools: [{ name: "user-write" }] })],
      { builtins: { context7: HTTP("https://builtin.test") }, now: () => ++clock },
    );
    await runtime.apply(CONFIG({ external: HTTP("https://user.test") }));

    const withoutBuiltin = runtime.snapshotTools({ builtinServerNames: [] });
    expect([...withoutBuiltin.descriptors.values()].map((tool) => tool.description)).toEqual([
      'MCP tool "user-write" from server "external".',
    ]);
    expect(Object.keys(withoutBuiltin.statuses.servers)).toEqual(["external"]);

    const withBuiltin = runtime.snapshotTools({ builtinServerNames: ["context7"] });
    expect(withBuiltin.descriptors.size).toBe(2);
    expect(Object.keys(withBuiltin.statuses.servers).sort()).toEqual(["context7", "external"]);
    expect(withBuiltin.statuses.servers.context7?.state).toBe("ready");
  });

  test("keeps disabled user and builtin status out of descriptors", async () => {
    const runtime = serviceWith([], { builtins: { context7: HTTP("https://builtin.test") } });
    await runtime.apply(CONFIG({ external: { ...HTTP("https://user.test"), enabled: false } }, ["context7"]));
    const snapshot = runtime.snapshotTools({ builtinServerNames: ["context7"] });
    expect(snapshot.descriptors.size).toBe(0);
    expect(snapshot.statuses.servers.external?.state).toBe("disabled");
    expect(snapshot.statuses.servers.context7?.state).toBe("disabled");
  });

  test("accepts empty optional MCP header and env values without building invalid redaction literals", async () => {
    const runtime = serviceWith([sdk(), sdk()]);
    await runtime.apply(CONFIG({
      http: HTTP("https://http.test", { "X-Optional": "" }),
      stdio: STDIO("mcp-stdio", { OPTIONAL_TOKEN: "" }),
    }));

    expect(runtime.getStatus().servers.http?.state).toBe("ready");
    expect(runtime.getStatus().servers.stdio?.state).toBe("ready");
  });

  test("retire before acquire makes an old run-local descriptor unavailable immediately", async () => {
    const nextConnect = deferred<void>();
    const first = sdk({ tools: [{ name: "lookup" }] });
    const second = sdk({ connect: () => nextConnect.promise, tools: [{ name: "lookup-new" }] });
    const runtime = serviceWith([first, second]);
    await runtime.apply(CONFIG({ docs: HTTP("https://one.test") }));
    const old = [...runtime.snapshotTools({ builtinServerNames: [] }).descriptors.values()][0]!;

    const applying = runtime.apply(CONFIG({ docs: HTTP("https://two.test") }));
    const result = await execute(old);
    expect(result.details?.error?.code).toBe("TOOL_MCP_NOT_AVAILABLE");
    expect(first.close).toHaveBeenCalledTimes(1);
    nextConnect.resolve();
    await applying;
  });

  test("an acquired call drains on its original handle and closes exactly once", async () => {
    const call = deferred<CallToolResultLike>();
    const nextConnect = deferred<void>();
    const first = sdk({ call: () => call.promise });
    const second = sdk({ connect: () => nextConnect.promise, tools: [{ name: "new-tool" }] });
    const runtime = serviceWith([first, second]);
    await runtime.apply(CONFIG({ docs: HTTP("https://one.test", { Authorization: "old-secret-value" }) }));
    const old = [...runtime.snapshotTools({ builtinServerNames: [] }).descriptors.values()][0]!;
    const running = execute(old);
    expect(first.callTool).toHaveBeenCalledTimes(1);

    const applying = runtime.apply(CONFIG({ docs: HTTP("https://two.test") }));
    expect(first.close).not.toHaveBeenCalled();
    call.resolve({ content: [{ type: "text", text: "old-secret-value" }] });
    const result = await running;
    expect(result.draft.kind === "text" ? result.draft.text : "").toBe("[REDACTED:SECRET]");
    expect(first.close).toHaveBeenCalledTimes(1);
    nextConnect.resolve();
    await applying;
    expect(first.close).toHaveBeenCalledTimes(1);
  });

  test("late completion from a losing epoch cannot republish stale tools", async () => {
    const oldConnect = deferred<void>();
    const old = sdk({ connect: () => oldConnect.promise, tools: [{ name: "old-tool" }] });
    const current = sdk({ tools: [{ name: "current-tool" }] });
    const runtime = serviceWith([old, current]);
    const firstApply = runtime.apply(CONFIG({ docs: HTTP("https://old.test") }));
    await runtime.apply(CONFIG({ docs: HTTP("https://current.test") }));
    oldConnect.resolve();
    await firstApply;
    const inventory = runtime.getInventory().servers.docs ?? [];
    expect(inventory.map((tool) => tool.name)).toEqual(["current-tool"]);
    expect(old.close).toHaveBeenCalledTimes(1);
  });

  test("one failed server is isolated from another ready server", async () => {
    const failed = sdk({ connect: async () => { throw new Error("connection failed"); } });
    const ready = sdk({ tools: [{ name: "ok" }] });
    const runtime = serviceWith([failed, ready]);
    await runtime.apply(CONFIG({ bad: HTTP("https://bad.test"), good: HTTP("https://good.test") }));
    expect(runtime.getStatus().servers.bad?.state).toBe("failed");
    expect(runtime.getStatus().servers.good?.state).toBe("ready");
    expect(runtime.getInventory().servers.good?.map((tool) => tool.name)).toEqual(["ok"]);
  });

  test("does not silently filter a resolved secret that violates the runtime policy", async () => {
    const runtime = serviceWith([]);
    await runtime.apply(CONFIG({ docs: HTTP("https://docs.test", { Authorization: "short" }) }));
    expect(runtime.getStatus().servers.docs).toMatchObject({
      state: "failed",
      error: expect.stringContaining("safe secret redaction policy"),
    });
    expect(runtime.getInventory().servers.docs).toBeUndefined();
  });

  test("testServer is ephemeral and does not mutate live status or inventory", async () => {
    const temporary = sdk({ tools: [{ name: "draft.tool", description: "Draft" }] });
    const runtime = serviceWith([temporary]);
    const result = await runtime.testServer("draft", HTTP("https://draft.test"));
    expect(result.tools[0]).toMatchObject({ serverName: "draft", name: "draft.tool", description: "Draft" });
    expect(runtime.getStatus().servers).toEqual({});
    expect(runtime.getInventory().servers).toEqual({});
    expect(temporary.close).toHaveBeenCalledTimes(1);
  });

  test("redacts discovered descriptions before exposing descriptors or inventory", async () => {
    const secret = "description-secret-value";
    const client = sdk({ tools: [{ name: "lookup", description: `Uses ${secret}` }] });
    const runtime = serviceWith([client]);

    await runtime.apply(CONFIG({ docs: HTTP("https://docs.test", { Authorization: secret }) }));

    const descriptor = [...runtime.snapshotTools({ builtinServerNames: [] }).descriptors.values()][0];
    expect(descriptor?.description).toContain("[REDACTED:SECRET]");
    expect(JSON.stringify(runtime.getInventory())).not.toContain(secret);
  });

  test("deep-redacts discovery metadata while dispatching the private raw tool name", async () => {
    const secret = "metadata-secret-value";
    const client = sdk({
      tools: [{
        name: `lookup-${secret}`,
        description: `Uses ${secret}`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", default: secret, examples: [`find ${secret}`] },
          },
        },
      }],
    });
    const runtime = serviceWith([client]);

    await runtime.apply(CONFIG({ docs: HTTP("https://docs.test", { Authorization: secret }) }));

    const inventory = runtime.getInventory();
    const descriptor = [...runtime.snapshotTools({ builtinServerNames: [] }).descriptors.values()][0]!;
    expect(JSON.stringify(inventory)).not.toContain(secret);
    expect(descriptor.name).not.toContain(secret);
    expect(descriptor.description).not.toContain(secret);
    expect(JSON.stringify(descriptor.aiInputSchema)).not.toContain(secret);
    await execute(descriptor);
    expect(client.callTool).toHaveBeenCalledWith(
      { name: `lookup-${secret}`, arguments: {} },
      undefined,
      expect.anything(),
    );
  });

  test("an unexpected HTTP SDK close synchronously retires a ready handle", async () => {
    const client = sdk({ tools: [{ name: "lookup" }] });
    const runtime = serviceWith([client]);
    await runtime.apply(CONFIG({ docs: HTTP("https://docs.test") }));
    const old = [...runtime.snapshotTools({ builtinServerNames: [] }).descriptors.values()][0]!;

    client.onclose?.();

    expect(runtime.getStatus().servers.docs?.state).toBe("failed");
    expect(runtime.getInventory().servers.docs).toBeUndefined();
    expect(runtime.snapshotTools({ builtinServerNames: [] }).descriptors.size).toBe(0);
    expect((await execute(old)).details?.error?.code).toBe("TOOL_MCP_NOT_AVAILABLE");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("an unexpected STDIO transport error is redacted and fences late discovery", async () => {
    const secret = "stdio-secret-value";
    const connected = deferred<void>();
    const client = sdk({
      connect: async () => connected.promise,
      tools: [{ name: "late-tool" }],
    });
    const transport: McpTransportLike = {};
    const runtime = serviceWith([client], { transports: [transport] });
    const applying = runtime.apply(CONFIG({ local: STDIO("mcp-local", { TOKEN: secret }) }));

    transport.onerror?.(new Error(`transport lost ${secret}`));
    expect(runtime.getStatus().servers.local).toMatchObject({
      state: "failed",
      error: "transport lost [REDACTED:SECRET]",
    });
    expect(runtime.getInventory().servers.local).toBeUndefined();

    connected.resolve();
    await applying;
    expect(runtime.getStatus().servers.local?.state).toBe("failed");
    expect(runtime.getInventory().servers.local).toBeUndefined();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("coalesces duplicate reconnects and rejects a duplicate pending draft test", async () => {
    const reconnectGate = deferred<void>();
    const testGate = deferred<void>();
    const initial = sdk();
    const reconnected = sdk({ connect: () => reconnectGate.promise });
    const temporary = sdk({ connect: () => testGate.promise });
    const runtime = serviceWith([initial, reconnected, temporary]);
    await runtime.apply(CONFIG({ docs: HTTP("https://docs.test") }));

    const firstReconnect = runtime.reconnect("docs");
    const secondReconnect = runtime.reconnect("docs");
    expect(secondReconnect).toBe(firstReconnect);
    reconnectGate.resolve();
    await firstReconnect;
    expect(reconnected.connect).toHaveBeenCalledTimes(1);

    const firstTest = runtime.testServer("draft", HTTP("https://draft.test"));
    await expect(runtime.testServer("draft", HTTP("https://draft.test"))).rejects.toThrow("already in progress");
    testGate.resolve();
    await firstTest;
    expect(temporary.connect).toHaveBeenCalledTimes(1);
  });

  test("publishes failed and removes inventory when reconnect cannot establish a replacement", async () => {
    const initial = sdk({ tools: [{ name: "lookup" }] });
    const failed = sdk({ connect: async () => { throw new Error("credential rejected"); } });
    const runtime = serviceWith([initial, failed]);
    await runtime.apply(CONFIG({ docs: HTTP("https://docs.test") }));
    expect(runtime.getInventory().servers.docs).toHaveLength(1);

    await runtime.reconnect("docs");

    const status = runtime.getStatus().servers.docs;
    expect(status).toMatchObject({ state: "failed" });
    expect(status?.state === "failed" ? status.error : undefined).toContain("credential rejected");
    expect(runtime.getInventory().servers.docs).toBeUndefined();
    expect(initial.close).toHaveBeenCalledTimes(1);
    expect(failed.close).toHaveBeenCalledTimes(1);
  });

  test("bounds concurrent draft transports across distinct drafts", async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_MCP_DRAFT_TESTS }, () => deferred<void>());
    const clients = gates.map((gate) => sdk({ connect: () => gate.promise }));
    const runtime = serviceWith(clients);
    const tests = gates.map((_gate, index) => runtime.testServer(
      `draft-${index}`,
      HTTP(`https://draft-${index}.test`),
    ));

    await expect(runtime.testServer("overflow", HTTP("https://overflow.test"))).rejects.toThrow(
      `At most ${MAX_CONCURRENT_MCP_DRAFT_TESTS}`,
    );
    gates.forEach((gate) => gate.resolve());
    await Promise.all(tests);
  });

  test("close aborts candidates and closes every handle once", async () => {
    const connecting = deferred<void>();
    const pending = sdk({ connect: () => connecting.promise });
    const runtime = serviceWith([pending]);
    const applying = runtime.apply(CONFIG({ docs: HTTP("https://docs.test") }));
    const closing = runtime.close();
    connecting.resolve();
    await Promise.all([applying, closing]);
    await runtime.close();
    expect(pending.close).toHaveBeenCalledTimes(1);
  });

  test("close aborts and drains an in-flight draft test exactly once", async () => {
    let signal: AbortSignal | undefined;
    const temporary = sdk({
      connect: async (_transport, options) => {
        signal = options?.signal;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new Error("draft test aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const runtime = serviceWith([temporary]);
    const testing = runtime.testServer("draft", HTTP("https://draft.test"));

    await runtime.close();

    expect(signal?.aborted).toBe(true);
    await expect(testing).rejects.toMatchObject({ reason: "aborted" });
    expect(temporary.close).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(temporary.close).toHaveBeenCalledTimes(1);
  });

  test("rejects lifecycle operations after close", async () => {
    const runtime = serviceWith([]);
    await runtime.close();

    await expect(runtime.apply(CONFIG({ docs: HTTP("https://docs.test") }))).rejects.toThrow("closed");
    expect(() => runtime.reconnect("docs")).toThrow("closed");
    await expect(runtime.testServer("draft", HTTP("https://draft.test"))).rejects.toThrow("closed");
  });

  test("forwards a caller abort into an in-flight draft test", async () => {
    let internalSignal: AbortSignal | undefined;
    const temporary = sdk({
      connect: async (_transport, options) => {
        internalSignal = options?.signal;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new Error("request disconnected");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const runtime = serviceWith([temporary]);
    const caller = new AbortController();
    const testing = runtime.testServer("draft", HTTP("https://draft.test"), { signal: caller.signal });

    caller.abort();

    await expect(testing).rejects.toMatchObject({ reason: "aborted" });
    expect(internalSignal?.aborted).toBe(true);
    expect(temporary.close).toHaveBeenCalledTimes(1);
  });
});
