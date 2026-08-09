import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedMcpConfig } from "../config/mcp";
import type { RawToolResult, ToolExecutionContext } from "../tools/types";
import {
  createDefaultMcpClientFactories,
  type McpClientFactories,
  type McpTransportLike,
} from "./client";
import { McpRuntimeService } from "./runtime-service";

const runtimes: McpRuntimeService[] = [];
const httpServers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const server of httpServers.splice(0)) server.stop(true);
});

async function execute(runtime: McpRuntimeService, input: Record<string, unknown>): Promise<RawToolResult> {
  const descriptor = [...runtime.snapshotTools({ builtinServerNames: [] }).descriptors.values()][0]!;
  return await descriptor.execute(input, { abort: new AbortController().signal } as ToolExecutionContext) as RawToolResult;
}

function paginatedServer(prefix: string): Server {
  const tool = (suffix: string) => ({
    name: `${prefix}.${suffix}`,
    description: `${prefix} paginated fixture tool ${suffix}`,
    inputSchema: {
      type: "object" as const,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    annotations: { readOnlyHint: true },
  });
  const server = new Server(
    { name: `${prefix}-fixture`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) => (
    params?.cursor === "page-2"
      ? { tools: [tool("two")] }
      : { tools: [tool("one")], nextCursor: "page-2" }
  ));
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => ({
    content: [{ type: "text", text: String(params.arguments?.value ?? "") }],
  }));
  return server;
}

async function startHttpFixture(prefix: string) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const mcpServers = new Set<Server>();
  let sessionInitializeCount = 0;
  let sessionCloseCount = 0;
  const httpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId !== null) {
        const transport = sessions.get(sessionId);
        return transport === undefined
          ? new Response("Unknown MCP session", { status: 404 })
          : await transport.handleRequest(request);
      }
      if (request.method !== "POST") return new Response("Missing MCP session", { status: 400 });

      const mcpServer = paginatedServer(prefix);
      mcpServers.add(mcpServer);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessionInitializeCount += 1;
          sessions.set(id, transport);
        },
        onsessionclosed: (id) => {
          sessionCloseCount += 1;
          sessions.delete(id);
        },
      });
      await mcpServer.connect(transport);
      return await transport.handleRequest(request);
    },
  });
  httpServers.push(httpServer);
  return {
    url: `http://127.0.0.1:${httpServer.port}/mcp`,
    get activeSessionCount() { return sessions.size; },
    get sessionInitializeCount() { return sessionInitializeCount; },
    get sessionCloseCount() { return sessionCloseCount; },
    close: async () => {
      await Promise.allSettled([...mcpServers].map((server) => server.close()));
    },
  };
}

function httpConfig(url: string): ResolvedMcpConfig["servers"][string] {
  return {
    type: "http",
    enabled: true,
    url,
    connectTimeoutMs: 2_000,
    discoveryTimeoutMs: 2_000,
    callTimeoutMs: 2_000,
  };
}

function stdioConfig(prefix: string): ResolvedMcpConfig["servers"][string] {
  return {
    type: "stdio",
    enabled: true,
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/stdio-server.ts", import.meta.url)), prefix],
    connectTimeoutMs: 2_000,
    discoveryTimeoutMs: 2_000,
    callTimeoutMs: 2_000,
  };
}

describe("official MCP transports", () => {
  test("Streamable HTTP paginates, tests, reconnects, changes config, disables and closes an active session", async () => {
    const first = await startHttpFixture("http-first");
    const second = await startHttpFixture("http-second");
    const defaults = createDefaultMcpClientFactories();
    let transportCreations = 0;
    const factories: McpClientFactories = {
      createClient: defaults.createClient,
      createTransport(config) {
        transportCreations += 1;
        return defaults.createTransport(config);
      },
    };
    const runtime = new McpRuntimeService({ builtinServers: {}, clientFactories: factories });
    runtimes.push(runtime);
    const enabled: ResolvedMcpConfig = {
      disabledBuiltins: [],
      servers: { local: httpConfig(first.url) },
    };

    const draft = await runtime.testServer("draft", enabled.servers.local!);
    expect(draft.tools.map((tool) => tool.name)).toEqual(["http-first.one", "http-first.two"]);
    expect(runtime.getStatus().servers.draft).toBeUndefined();
    expect(runtime.getInventory().servers.draft).toBeUndefined();
    expect(first.activeSessionCount).toBe(0);
    expect(first.sessionCloseCount).toBe(first.sessionInitializeCount);

    await runtime.apply(enabled);
    expect(first.activeSessionCount).toBe(1);
    expect(runtime.getInventory().servers.local?.map((tool) => tool.name)).toEqual([
      "http-first.one",
      "http-first.two",
    ]);
    const result = await execute(runtime, { value: "http-ok" });
    expect(result.draft.kind === "text" ? result.draft.text : "").toBe("http-ok");

    const firstCloseCountBeforeReconnect = first.sessionCloseCount;
    await runtime.reconnect("local");
    expect(first.activeSessionCount).toBe(1);
    expect(first.sessionCloseCount).toBe(firstCloseCountBeforeReconnect + 1);
    expect(runtime.getInventory().servers.local?.map((tool) => tool.name)).toEqual([
      "http-first.one",
      "http-first.two",
    ]);
    const firstCloseCountBeforeReplace = first.sessionCloseCount;
    const secondCloseCountBeforeReplace = second.sessionCloseCount;
    await runtime.apply({
      ...enabled,
      servers: { local: httpConfig(second.url) },
    });
    expect(first.activeSessionCount).toBe(0);
    expect(first.sessionCloseCount).toBe(firstCloseCountBeforeReplace + 1);
    expect(second.activeSessionCount).toBe(1);
    expect(second.sessionCloseCount).toBe(secondCloseCountBeforeReplace);
    expect(runtime.getInventory().servers.local?.map((tool) => tool.name)).toEqual([
      "http-second.one",
      "http-second.two",
    ]);
    expect(transportCreations).toBe(4);

    const secondCloseCountBeforeRemoval = second.sessionCloseCount;
    await runtime.apply({ disabledBuiltins: [], servers: {} });
    await expectHttpSessionClose(second, secondCloseCountBeforeRemoval);
    expect(second.activeSessionCount).toBe(0);
    expect(second.sessionCloseCount).toBe(secondCloseCountBeforeRemoval + 1);
    expect(runtime.getStatus().servers.local).toBeUndefined();
    expect(runtime.getInventory().servers.local).toBeUndefined();
    expect(runtime.snapshotTools({ builtinServerNames: [] }).descriptors.size).toBe(0);

    const secondEnabled: ResolvedMcpConfig = {
      disabledBuiltins: [],
      servers: { local: httpConfig(second.url) },
    };
    await runtime.apply(secondEnabled);
    expect(second.activeSessionCount).toBe(1);
    const secondCloseCountBeforeDisable = second.sessionCloseCount;
    await runtime.apply({
      ...secondEnabled,
      servers: { local: { ...secondEnabled.servers.local!, enabled: false } },
    });
    await expectHttpSessionClose(second, secondCloseCountBeforeDisable);
    expect(second.activeSessionCount).toBe(0);
    expect(second.sessionCloseCount).toBe(secondCloseCountBeforeDisable + 1);
    expect(runtime.getStatus().servers.local?.state).toBe("disabled");
    expect(runtime.getInventory().servers.local).toBeUndefined();
    expect(runtime.snapshotTools({ builtinServerNames: [] }).descriptors.size).toBe(0);

    await runtime.apply(secondEnabled);
    expect(runtime.getStatus().servers.local?.state).toBe("ready");
    expect(runtime.getInventory().servers.local?.map((tool) => tool.name)).toEqual([
      "http-second.one",
      "http-second.two",
    ]);
    const sessionCloseCountBeforeShutdown = second.sessionCloseCount;
    expect(second.activeSessionCount).toBe(1);
    await runtime.close();
    expect(second.activeSessionCount).toBe(0);
    expect(second.sessionCloseCount).toBe(sessionCloseCountBeforeShutdown + 1);
    await Promise.all([first.close(), second.close()]);
  });

  test("STDIO paginates, tests, reconnects, changes config, disables and terminates children", async () => {
    const defaults = createDefaultMcpClientFactories();
    const stdioTransports: Array<McpTransportLike & Pick<StdioClientTransport, "pid">> = [];
    const stdioPids: Array<number | null> = [];
    const factories: McpClientFactories = {
      createClient: defaults.createClient,
      createTransport(config) {
        const transport = defaults.createTransport(config);
        if (config.type === "stdio") {
          const stdio = transport as McpTransportLike
            & Pick<StdioClientTransport, "pid">
            & { start(): Promise<void> };
          const start = stdio.start.bind(stdio);
          stdio.start = async () => {
            await start();
            stdioPids.push(stdio.pid);
          };
          stdioTransports.push(stdio);
        }
        return transport;
      },
    };
    const runtime = new McpRuntimeService({ builtinServers: {}, clientFactories: factories });
    runtimes.push(runtime);
    const enabled: ResolvedMcpConfig = {
      disabledBuiltins: [],
      servers: { local: stdioConfig("stdio-first") },
    };

    const statusBeforeDraft = runtime.getStatus();
    const inventoryBeforeDraft = runtime.getInventory();
    const draft = await runtime.testServer("draft", stdioConfig("stdio-draft"));
    const draftPid = stdioPids[0];
    expect(draftPid).toBeNumber();
    expect(draft.tools.map((tool) => tool.name)).toEqual([
      "stdio-draft.one",
      "stdio-draft.two",
    ]);
    if (draftPid) await expectProcessExit(draftPid);
    expect(runtime.getStatus()).toEqual(statusBeforeDraft);
    expect(runtime.getInventory()).toEqual(inventoryBeforeDraft);

    await runtime.apply(enabled);
    const firstPid = stdioTransports[1]?.pid;
    expect(firstPid).toBeNumber();
    expect(runtime.getInventory().servers.local?.map((tool) => tool.name)).toEqual([
      "stdio-first.one",
      "stdio-first.two",
    ]);
    const result = await execute(runtime, { value: "stdio-ok" });
    expect(result.draft.kind === "text" ? result.draft.text : "").toBe("stdio-ok");

    await runtime.reconnect("local");
    const reconnectPid = stdioTransports[2]?.pid;
    expect(reconnectPid).toBeNumber();
    if (firstPid) await expectProcessExit(firstPid);

    await runtime.apply({
      ...enabled,
      servers: { local: stdioConfig("stdio-second") },
    });
    const replacementPid = stdioTransports[3]?.pid;
    expect(replacementPid).toBeNumber();
    if (reconnectPid) await expectProcessExit(reconnectPid);
    expect(runtime.getInventory().servers.local?.map((tool) => tool.name)).toEqual([
      "stdio-second.one",
      "stdio-second.two",
    ]);

    await runtime.apply({
      ...enabled,
      servers: { local: { ...enabled.servers.local!, enabled: false } },
    });
    if (replacementPid) await expectProcessExit(replacementPid);
    expect(runtime.getStatus().servers.local?.state).toBe("disabled");

    await runtime.apply(enabled);
    const shutdownPid = stdioTransports[4]?.pid;
    expect(shutdownPid).toBeNumber();
    await runtime.close();
    if (shutdownPid) await expectProcessExit(shutdownPid);
  });
});

async function expectProcessExit(pid: number): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`STDIO MCP fixture process ${pid} remained alive after transport close`);
}

async function expectHttpSessionClose(
  fixture: { readonly sessionCloseCount: number },
  previousCloseCount: number,
): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    if (fixture.sessionCloseCount > previousCloseCount) return;
    await Bun.sleep(25);
  }
  throw new Error("HTTP MCP fixture session remained active after transport close");
}
