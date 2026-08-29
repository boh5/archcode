import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { McpServerStatus } from "@archcode/protocol";
import type { ResolvedMcpConfig } from "./config/mcp";
import { ServerConfigService, resolveServerConfigPath } from "./config";
import { createTestMcpRuntime, type TestMcpRuntime } from "./testing/test-mcp-runtime";
import { createRuntime as createProductionRuntime, type AgentRuntime, type AgentRuntimeOptions } from "./runtime";
import { ProjectRegistry } from "./projects/registry";
import { silentLogger } from "./logger";
import { ToolOutputArtifactStore } from "./tool-output/artifact-store";
import { defineTool } from "./tools/index";
import type { AnyToolDescriptor } from "./tools/types";
import { setLlmAdapterForTest } from "./llm";
import { McpRuntimeService } from "./mcp/runtime-service";
import type {
  CallToolResultLike,
  McpClientFactories,
  McpSdkClientLike,
  McpTransportLike,
} from "./mcp/client";

type RuntimeTestOptions = Omit<AgentRuntimeOptions, "activation" | "projectRegistry"> & {
  projectRegistry?: ProjectRegistry;
  toolOutputStoreFactory?: (rootDir: string) => ToolOutputArtifactStore;
  executionManagerShutdown?: () => Promise<void>;
  sessionAgentManagerDisposeAll?: () => void;
};

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

afterEach(() => setLlmAdapterForTest(undefined));

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archcode-runtime-mcp-"));
  tmpRoots.push(root);
  return root;
}

async function createRuntime(options: RuntimeTestOptions): ReturnType<typeof createProductionRuntime> {
  const result = await options.configService.activateForStartup();
  if (result.status !== "ready") throw new Error(`Expected ready config, received ${result.status}`);
  const runtimeStorageHomeDir = options.runtimeStorageHomeDir ?? await makeTempRoot();
  return createProductionRuntime({
    ...options,
    activation: result.activation,
    projectRegistry: options.projectRegistry
      ?? new ProjectRegistry({ homeDir: runtimeStorageHomeDir, logger: silentLogger }),
    runtimeStorageHomeDir,
  });
}

async function writeConfig(config: Record<string, unknown>): Promise<ServerConfigService> {
  const root = await makeTempRoot();
  const configPath = resolveServerConfigPath(root);
  await mkdir(join(root, ".archcode"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
  return new ServerConfigService({ homeDir: root });
}

function makeProviderConfig() {
  return {
    local: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local LLM",
      options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" },
      models: {
        "test-model": {
          name: "Test Model",
          limit: { context: 128000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  };
}

function makeConfig(mcp?: Record<string, unknown>): Record<string, unknown> {
  const config = {
    provider: makeProviderConfig(),
    profiles: {
      principal: { model: "local:test-model" },
      deep: { model: "local:test-model" },
      fast: { model: "local:test-model" },
    },
  };
  return mcp === undefined ? config : { ...config, mcp };
}

function makeMcpDescriptor(name = "mcp__context7__lookup"): AnyToolDescriptor {
  return defineTool({
    name,
    description: "Fake MCP lookup tool",
    inputSchema: z.object({}).catchall(z.unknown()),
    outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async () => ({ isError: false, draft: { kind: "text", text: "mcp output" } }),
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function toolCallStream(toolName: string, toolCallId: string): unknown {
  const input = { value: toolCallId };
  return {
    fullStream: (async function* () {
      yield { type: "tool-input-start", id: toolCallId, toolName };
      yield { type: "tool-call", toolCallId, toolName, input };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([{ toolCallId, toolName, input }]),
  };
}

function toolSearchStream(query: string, toolCallId: string, namespace: string): unknown {
  const input = { query, namespace, limit: 1 };
  return {
    fullStream: (async function* () {
      yield { type: "tool-input-start", id: toolCallId, toolName: "tool_search" };
      yield { type: "tool-call", toolCallId, toolName: "tool_search", input };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([{ toolCallId, toolName: "tool_search", input }]),
  };
}

function stoppedStream(): unknown {
  return {
    fullStream: (async function* () {})(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve("done"),
    toolCalls: Promise.resolve([]),
  };
}

function waitForExecutionEnd(runtime: AgentRuntime, slug: string, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = runtime.subscribeSessionEvents((event) => {
      if (event.slug !== slug || event.sessionId !== sessionId || event.payload.type !== "execution-end") return;
      unsubscribe();
      resolve();
    });
  });
}

describe("createRuntime MCP facade", () => {
  test("applies resolved configuration and exposes live status/inventory snapshots", async () => {
    let applied: ResolvedMcpConfig | undefined;
    const mcpRuntime = createTestMcpRuntime({
      apply: async (config) => { applied = config; },
      statuses: { servers: { docs: { state: "connecting", startedAt: 1 } } },
      inventory: { servers: { docs: [] } },
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => mcpRuntime,
    });

    await Promise.resolve();
    expect(applied).toEqual({ disabledBuiltins: [], servers: {} });
    expect(runtime.getMcpServerStatus()).toEqual({
      servers: { docs: { state: "connecting", startedAt: 1 } },
    });
    expect(runtime.getMcpServerInventory()).toEqual({ servers: { docs: [] } });
  });

  test("bridges status listeners and supports unsubscribe", async () => {
    const mcpRuntime = createTestMcpRuntime();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => mcpRuntime,
    });
    const calls: Array<{ serverName: string; status: McpServerStatus }> = [];
    const unsubscribe = runtime.subscribeMcpStatusChanges((serverName, status) => {
      calls.push({ serverName, status });
    });
    mcpRuntime.emitStatusChange("docs", { state: "ready", toolCount: 2, warningCount: 0, connectedAt: 2 });
    expect(calls).toEqual([{
      serverName: "docs",
      status: { state: "ready", toolCount: 2, warningCount: 0, connectedAt: 2 },
    }]);
    unsubscribe();
    mcpRuntime.emitStatusChange("docs", { state: "failed", error: "offline", failedAt: 3 });
    expect(calls).toHaveLength(1);
  });

  test("snapshotTools returns a run-local descriptor map and status projection", () => {
    const descriptor = makeMcpDescriptor();
    const mcpRuntime = createTestMcpRuntime({
      tools: new Map([[
        descriptor.name,
        { descriptor, serverName: "docs", source: "user" },
      ]]),
      statuses: { servers: { docs: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 4 } } },
    });
    const snapshot = mcpRuntime.snapshotTools({ builtinServerNames: [] });
    expect(snapshot.tools.get(descriptor.name)?.descriptor).toBe(descriptor);
    expect(snapshot.statuses).toEqual({
      servers: { docs: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 4 } },
    });
  });

  test("loads a ready MCP tool by exact registry alias and rejects it after disable", async () => {
    const context7Config = {
      type: "http" as const,
      enabled: true,
      url: "https://context7.test/mcp",
      connectTimeoutMs: 1_000,
      discoveryTimeoutMs: 1_000,
      callTimeoutMs: 1_000,
    };
    let closeCalls = 0;
    const client: McpSdkClientLike = {
      connect: async () => undefined,
      listTools: async () => ({
        tools: [{
          name: "lookup",
          description: "Look up documentation by query.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          annotations: { readOnlyHint: true },
        }],
      }),
      callTool: async (): Promise<CallToolResultLike> => ({
        content: [{ type: "text", text: "lookup result" }],
      }),
      close: async () => { closeCalls += 1; },
    };
    const mcpRuntime = new McpRuntimeService({
      builtinServers: { context7: context7Config },
      clientFactories: {
        createClient: () => client,
        createTransport: () => ({} as McpTransportLike),
      },
      logger: silentLogger,
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ disabledBuiltins: ["context7"], servers: {} })),
      mcpRuntimeFactory: () => mcpRuntime,
      logger: silentLogger,
    });
    try {
      await runtime.applyMcpConfig({ disabledBuiltins: [], servers: {} });
      const alias = runtime.getMcpServerInventory().servers.context7?.[0]?.registryName;
      if (alias === undefined) throw new Error("Expected the ready MCP tool to have a registry alias");

      const workspaceRoot = await makeTempRoot();
      const project = await runtime.projectRegistry.add({ workspaceRoot, name: "MCP exact loading" });
      const leadSession = await runtime.createSession(workspaceRoot, {
        agentName: "lead",
        source: { kind: "direct" },
      });
      const nonReadySession = await runtime.createSession(workspaceRoot, {
        agentName: "lead",
        source: { kind: "direct" },
      });
      const rounds = new Map<string, number>();
      const boundaries = new Map<string, Array<Record<string, unknown>>>();
      const systemPrompts = new Map<string, string[]>();
      setLlmAdapterForTest({
        streamText: mock((options: {
          messages: unknown;
          system?: string;
          tools?: Record<string, unknown>;
        }) => {
          const serialized = JSON.stringify(options.messages);
          const lane = serialized.includes("MCP_EXACT_READY")
            ? "ready"
            : "non-ready";
          const round = (rounds.get(lane) ?? 0) + 1;
          rounds.set(lane, round);
          const tools = options.tools ?? {};
          const laneBoundaries = boundaries.get(lane) ?? [];
          laneBoundaries.push(tools);
          boundaries.set(lane, laneBoundaries);
          const lanePrompts = systemPrompts.get(lane) ?? [];
          lanePrompts.push(options.system ?? "");
          systemPrompts.set(lane, lanePrompts);
          if (round === 1) return toolSearchStream(`select:${alias}`, `${lane}-search`, "context7");
          return stoppedStream();
        }) as never,
        generateText: mock(async () => ({ text: "MCP exact loading" })) as never,
      });

      const run = async (sessionId: string, text: string): Promise<void> => {
        const completed = waitForExecutionEnd(runtime, project.slug, sessionId);
        await runtime.acceptSessionMessage({
          slug: project.slug,
          workspaceRoot,
          sessionId,
          text,
          attachmentIds: [],
          clientRequestId: crypto.randomUUID(),
          source: "user",
          requestedModelSelection: { mode: "profile_default", selection: { model: "local:test-model" } },
        });
        await completed;
      };

      await run(leadSession.sessionId, "MCP_EXACT_READY");
      const readyBoundaries = boundaries.get("ready") ?? [];
      const readyPrompts = systemPrompts.get("ready") ?? [];
      expect(readyBoundaries).toHaveLength(2);
      expect(readyPrompts).toHaveLength(2);
      expect(readyBoundaries[0]?.[alias]).toBeUndefined();
      expect(readyPrompts[0]).toContain(`"name":"${alias}"`);
      expect(readyPrompts[0]).toContain('"description":"Look up documentation by query."');
      const loaded = readyBoundaries[1]?.[alias] as {
        readonly description?: unknown;
        readonly inputSchema?: unknown;
      } | undefined;
      expect(loaded?.description).toBe("Look up documentation by query.");
      expect(loaded?.inputSchema).toBeDefined();
      expect(readyPrompts[1]).not.toContain(`"name":"${alias}"`);

      expect(mcpRuntime.snapshotTools({ builtinServerNames: [] }).tools.has(alias)).toBeFalse();

      await runtime.applyMcpConfig({ disabledBuiltins: ["context7"], servers: {} });
      expect(runtime.getMcpServerStatus().servers.context7?.state).toBe("disabled");
      await run(nonReadySession.sessionId, "MCP_EXACT_NON_READY");
      const nonReadyBoundaries = boundaries.get("non-ready") ?? [];
      const nonReadyPrompts = systemPrompts.get("non-ready") ?? [];
      expect(nonReadyBoundaries).toHaveLength(2);
      expect(nonReadyBoundaries.every((tools) => tools[alias] === undefined)).toBeTrue();
      expect(nonReadyPrompts.every((prompt) => !prompt.includes(`"name":"${alias}"`))).toBeTrue();
      const nonReadyFile = await runtime.getSessionFile(workspaceRoot, nonReadySession.sessionId);
      const nonReadySearch = nonReadyFile.toolBatches
        .flatMap((batch) => batch.calls)
        .find((call) => call.toolName === "tool_search");
      expect(nonReadySearch).toMatchObject({
        state: "failed",
        result: { isError: true, details: { error: { code: "TOOL_SEARCH_NO_MATCH" } } },
      });
      expect(nonReadyFile.executions.at(-1)?.loadedToolRefs.some((ref) => ref.name === alias)).toBeFalse();
      expect(nonReadyFile.executions.at(-1)?.loadedToolRefs).toEqual([]);
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
    }
    expect(closeCalls).toBe(1);
  });

  test("runtime shutdown closes the MCP facade exactly once", async () => {
    let closeCalls = 0;
    const mcpRuntime = createTestMcpRuntime({
      close: async () => { closeCalls += 1; },
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => mcpRuntime,
    });
    await runtime.shutdown();
    await runtime.shutdown();
    expect(closeCalls).toBe(1);
  });

  test("live MCP apply is visible at the next model boundary across projects without replacing Executions", async () => {
    const firstCallsStarted = deferred<void>();
    const secondCallsStarted = deferred<void>();
    const releaseFirstCalls = deferred<void>();
    const releaseSecondCalls = deferred<void>();
    let firstCallCount = 0;
    let secondCallCount = 0;
    const sdkClient = (
      toolName: string,
      onCall: () => Promise<void>,
    ): McpSdkClientLike => ({
      connect: async () => undefined,
      listTools: async () => ({
        tools: [{
          name: toolName,
          inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          annotations: { readOnlyHint: true },
        }],
      }),
      callTool: async ({ arguments: input }): Promise<CallToolResultLike> => {
        await onCall();
        return { content: [{ type: "text", text: String(input.value) }] };
      },
      close: async () => undefined,
    });
    const clients = [
      sdkClient("before.apply", async () => {
        firstCallCount += 1;
        if (firstCallCount === 2) firstCallsStarted.resolve();
        await releaseFirstCalls.promise;
      }),
      sdkClient("after.apply", async () => {
        secondCallCount += 1;
        if (secondCallCount === 2) secondCallsStarted.resolve();
        await releaseSecondCalls.promise;
      }),
    ];
    const factories: McpClientFactories = {
      createClient: () => {
        const client = clients.shift();
        if (client === undefined) throw new Error("Unexpected MCP connection");
        return client;
      },
      createTransport: () => ({} as McpTransportLike),
    };
    const mcpRuntime = new McpRuntimeService({ builtinServers: {}, clientFactories: factories });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => mcpRuntime,
      logger: silentLogger,
    });
    try {
    const initialConfig: ResolvedMcpConfig = {
      disabledBuiltins: [],
      servers: {
        shared: {
          type: "http",
          enabled: true,
          url: "https://before.test/mcp",
          connectTimeoutMs: 1_000,
          discoveryTimeoutMs: 1_000,
          callTimeoutMs: 1_000,
        },
      },
    };
    await runtime.applyMcpConfig(initialConfig);
    const initialServer = initialConfig.servers.shared;
    if (initialServer?.type !== "http") throw new Error("Expected the initial HTTP MCP config");
    const initialAlias = runtime.getMcpServerInventory().servers.shared?.[0]?.registryName;
    if (initialAlias === undefined) throw new Error("Initial MCP tool was not discovered");

    const workspaceA = await makeTempRoot();
    const workspaceB = await makeTempRoot();
    const projectA = await runtime.projectRegistry.add({ workspaceRoot: workspaceA, name: "MCP project A" });
    const projectB = await runtime.projectRegistry.add({ workspaceRoot: workspaceB, name: "MCP project B" });
    const sessionA = await runtime.createSession(workspaceA, { agentName: "lead", source: { kind: "direct" } });
    const sessionB = await runtime.createSession(workspaceB, { agentName: "lead", source: { kind: "direct" } });
    const rounds = new Map<string, number>();
    const boundaries: Array<{ project: string; round: number; tools: string[] }> = [];
    let replacementAlias = "";

    setLlmAdapterForTest({
      streamText: mock((options: { messages: unknown; tools?: Record<string, unknown> }) => {
        const serialized = JSON.stringify(options.messages);
        const project = serialized.includes("PROJECT_A_BOUNDARY") ? "A" : "B";
        const round = (rounds.get(project) ?? 0) + 1;
        rounds.set(project, round);
        boundaries.push({ project, round, tools: Object.keys(options.tools ?? {}) });
        if (round === 1) return toolSearchStream(initialAlias, `${project}-search-before`, "shared");
        if (round === 2) return toolCallStream(initialAlias, `${project}-before`);
        if (round === 3) return toolSearchStream(replacementAlias, `${project}-search-after`, "shared");
        if (round === 4) return toolCallStream(replacementAlias, `${project}-after`);
        return stoppedStream();
      }) as never,
      generateText: mock(async () => ({ text: "", toolCalls: [] })) as never,
    });

    const completedA = waitForExecutionEnd(runtime, projectA.slug, sessionA.sessionId);
    const completedB = waitForExecutionEnd(runtime, projectB.slug, sessionB.sessionId);
    await Promise.all([
      runtime.acceptSessionMessage({
        slug: projectA.slug,
        workspaceRoot: workspaceA,
        sessionId: sessionA.sessionId,
        text: "PROJECT_A_BOUNDARY",
        attachmentIds: [],
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection: { mode: "profile_default", selection: { model: "local:test-model" } },
      }),
      runtime.acceptSessionMessage({
        slug: projectB.slug,
        workspaceRoot: workspaceB,
        sessionId: sessionB.sessionId,
        text: "PROJECT_B_BOUNDARY",
        attachmentIds: [],
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection: { mode: "profile_default", selection: { model: "local:test-model" } },
      }),
    ]);
    await firstCallsStarted.promise;

    await runtime.applyMcpConfig({
      ...initialConfig,
      servers: { shared: { ...initialServer, url: "https://after.test/mcp" } },
    });
    replacementAlias = runtime.getMcpServerInventory().servers.shared?.[0]?.registryName ?? "";
    expect(replacementAlias).not.toBe("");
    expect(replacementAlias).not.toBe(initialAlias);
    releaseFirstCalls.resolve();
    await secondCallsStarted.promise;

    const liveA = await runtime.getSessionFile(workspaceA, sessionA.sessionId);
    const liveB = await runtime.getSessionFile(workspaceB, sessionB.sessionId);
    expect(liveA.isRunning).toBeTrue();
    expect(liveB.isRunning).toBeTrue();
    expect(liveA.currentExecutionId).toBeString();
    expect(liveB.currentExecutionId).toBeString();
    const executionIdA = liveA.currentExecutionId;
    const executionIdB = liveB.currentExecutionId;
    if (executionIdA === undefined || executionIdB === undefined) {
      throw new Error("Expected both live Sessions to retain an active Execution");
    }
    await runtime.applyMcpConfig({
      ...initialConfig,
      servers: { shared: { ...initialServer, enabled: false } },
    });
    releaseSecondCalls.resolve();
    await Promise.all([completedA, completedB]);

    for (const project of ["A", "B"]) {
      const projectBoundaries = boundaries.filter((entry) => entry.project === project);
      expect(projectBoundaries).toHaveLength(5);
      expect(projectBoundaries[0]!.tools).toContain("tool_search");
      expect(projectBoundaries[0]!.tools).not.toContain(initialAlias);
      expect(projectBoundaries[1]!.tools).toContain(initialAlias);
      expect(projectBoundaries[1]!.tools).not.toContain(replacementAlias);
      expect(projectBoundaries[2]!.tools).toContain("tool_search");
      expect(projectBoundaries[2]!.tools).not.toContain(initialAlias);
      expect(projectBoundaries[2]!.tools).not.toContain(replacementAlias);
      expect(projectBoundaries[3]!.tools).toContain(replacementAlias);
      expect(projectBoundaries[3]!.tools).not.toContain(initialAlias);
      expect(projectBoundaries[4]!.tools).not.toContain(initialAlias);
      expect(projectBoundaries[4]!.tools).not.toContain(replacementAlias);
    }
    const finalA = await runtime.getSessionFile(workspaceA, sessionA.sessionId);
    const finalB = await runtime.getSessionFile(workspaceB, sessionB.sessionId);
    expect(finalA.executions).toHaveLength(1);
    expect(finalB.executions).toHaveLength(1);
    expect(finalA.executions[0]?.id).toBe(executionIdA);
    expect(finalB.executions[0]?.id).toBe(executionIdB);
    } finally {
      releaseFirstCalls.resolve();
      releaseSecondCalls.resolve();
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
    }
  });
});

describe("createRuntime tool output lifecycle", () => {
  test("retries only failed shutdown steps after a best-effort round", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const cleanupCalls: string[] = [];
    let executionShutdownAttempts = 0;
    const mcpRuntime = createTestMcpRuntime({ close: async () => { cleanupCalls.push("mcp"); } });
    const root = await makeTempRoot();
    class TrackingStore extends ToolOutputArtifactStore {
      override async dispose(): Promise<void> {
        cleanupCalls.push("artifacts");
        await super.dispose();
      }
    }

    const runtime = await createRuntime({
      configService,
      mcpRuntimeFactory: () => mcpRuntime,
      toolOutputRootDir: root,
      toolOutputStoreFactory: (rootDir) => new TrackingStore({ rootDir }),
      executionManagerShutdown: async () => {
        executionShutdownAttempts += 1;
        cleanupCalls.push(`executions:${executionShutdownAttempts}`);
        if (executionShutdownAttempts === 1) throw new Error("execution cleanup failed");
      },
      sessionAgentManagerDisposeAll: () => { cleanupCalls.push("agents"); },
    });

    const firstShutdown = runtime.shutdown();
    expect(runtime.shutdown()).toBe(firstShutdown);
    await expect(firstShutdown).rejects.toMatchObject({
      name: "AggregateError",
      message: "AgentRuntime shutdown failed",
    });
    expect(cleanupCalls).toEqual(["executions:1", "artifacts", "mcp", "agents"]);

    const retryShutdown = runtime.shutdown();
    expect(retryShutdown).not.toBe(firstShutdown);
    await retryShutdown;
    expect(cleanupCalls).toEqual(["executions:1", "artifacts", "mcp", "agents", "executions:2"]);
    expect(runtime.shutdown()).toBe(retryShutdown);
  });

  test("initializes the configured store and exposes awaited disposal", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const root = await makeTempRoot();
    let receivedRoot = "";
    let disposeCalls = 0;
    class TrackingStore extends ToolOutputArtifactStore {
      override async dispose(): Promise<void> {
        disposeCalls += 1;
        await super.dispose();
      }
    }
    const runtime = await createRuntime({
      configService,
      mcpRuntimeFactory: () => createTestMcpRuntime(),
      toolOutputRootDir: root,
      toolOutputStoreFactory: (rootDir) => {
        receivedRoot = rootDir;
        return new TrackingStore({ rootDir });
      },
    });
    expect(receivedRoot).toBe(root);
    await runtime.disposeToolOutputs();
    expect(disposeCalls).toBe(1);
  });

  test("disposes the store and closes MCP when store initialization fails", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const mcpRuntime = createTestMcpRuntime();
    const root = await makeTempRoot();
    let disposeCalls = 0;
    class FailingStore extends ToolOutputArtifactStore {
      override async ready(): Promise<void> { throw new Error("artifact init failed"); }
      override async dispose(): Promise<void> {
        disposeCalls += 1;
        await super.dispose();
      }
    }
    await expect(createRuntime({
      configService,
      mcpRuntimeFactory: () => mcpRuntime,
      toolOutputRootDir: root,
      toolOutputStoreFactory: (rootDir) => new FailingStore({ rootDir }),
    })).rejects.toThrow("artifact init failed");
    expect(disposeCalls).toBe(1);
  });
});
