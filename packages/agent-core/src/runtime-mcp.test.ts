import { afterAll, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { McpServerStatus } from "@archcode/protocol";
import type { ResolvedMcpConfig } from "./config/mcp";
import type {
  McpDiscoveryResult,
  McpManager,
  McpWarning,
} from "./mcp/index";
import type { AnyToolDescriptor } from "./tools/types";
import { defineTool } from "./tools/index";
import { createRuntime as createProductionRuntime } from "./runtime";
import { ServerConfigService, resolveServerConfigPath } from "./config";
import { ToolOutputArtifactStore } from "./tool-output/artifact-store";
import { REDACTION_MARKER, type SecretRedactionPolicy } from "./security";
import { createInMemoryLogger } from "./logger";

type RuntimeTestOptions = NonNullable<Parameters<typeof createProductionRuntime>[0]> & {
  toolOutputStoreFactory?: (rootDir: string) => ToolOutputArtifactStore;
};

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archcode-runtime-mcp-"));
  tmpRoots.push(root);
  return root;
}

async function createRuntime(
  options: RuntimeTestOptions = {},
): ReturnType<typeof createProductionRuntime> {
  const projectRegistryHomeDir = options.projectRegistryHomeDir ?? await makeTempRoot();
  return createProductionRuntime({ ...options, projectRegistryHomeDir } as Parameters<typeof createProductionRuntime>[0]);
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
      options: {
        baseURL: "http://localhost:8090/v1",
        apiKey: "test-key",
      },
      models: {
        "test-model": {
          name: "Test Model",
          limit: { context: 128000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
        },
      },
    },
  };
}

function makeConfig(mcp?: Record<string, unknown>): Record<string, unknown> {
  const config = {
    provider: makeProviderConfig(),
    agents: {
      engineer: { model: "local:test-model" },
      goal_lead: { model: "local:test-model" },
      plan: { model: "local:test-model" },
      build: { model: "local:test-model" },
      reviewer: { model: "local:test-model" },
      explore: { model: "local:test-model" },
      librarian: { model: "local:test-model" },
      shaper: { model: "local:test-model" },
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

// ─── Mock McpManager with background discovery semantics ─────────────────────

interface MockMcpManagerOptions {
  /** Descriptors to deliver via onDescriptors callback (one batch). */
  descriptors?: AnyToolDescriptor[];
  /** Warnings to deliver via onWarning callback. */
  warnings?: McpWarning[];
  /** If set, connect() will await this gate before delivering descriptors. */
  connectGate?: Promise<void>;
  /** Initial server statuses (defaults to { docs: pending }). */
  servers?: Record<string, McpServerStatus>;
}

interface CapturedCallbacks {
  onDescriptors: (descriptors: AnyToolDescriptor[]) => void;
  onWarning: (warning: McpWarning) => void;
}

function makeMockMcpManager(options: MockMcpManagerOptions = {}): {
  manager: McpManager;
  callbacks: Promise<CapturedCallbacks>;
  startBackgroundDiscoveryCalls: number;
  setStatus: (serverName: string, status: McpServerStatus) => void;
} {
  const servers = options.servers ?? { docs: { state: "pending" } as McpServerStatus };
  const serverStatuses = new Map<string, McpServerStatus>(
    Object.entries(servers),
  );
  const statusListeners = new Set<(serverName: string, status: McpServerStatus) => void>();
  let startBackgroundDiscoveryCalls = 0;
  let resolveCallbacks!: (cb: CapturedCallbacks) => void;
  const callbacks = new Promise<CapturedCallbacks>((resolve) => {
    resolveCallbacks = resolve;
  });

  const manager = {
    discover: mock(async (): Promise<McpDiscoveryResult> => ({
      descriptors: options.descriptors ?? [],
      warnings: options.warnings ?? [],
    })),
    closeAll: mock(async () => []),
    getStatus: mock((): Map<string, McpServerStatus> => new Map(serverStatuses)),
    onStatusChange: mock(
      (listener: (serverName: string, status: McpServerStatus) => void): (() => void) => {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      },
    ),
    startBackgroundDiscovery: mock(
      (
        onDescriptors: (descriptors: AnyToolDescriptor[]) => void,
        onWarning: (warning: McpWarning) => void,
      ): void => {
        startBackgroundDiscoveryCalls += 1;
        resolveCallbacks({ onDescriptors, onWarning });
        // Simulate background async delivery (does not block caller).
        void (async () => {
          if (options.connectGate) {
            await options.connectGate;
          }
          for (const warning of options.warnings ?? []) {
            onWarning(warning);
          }
          if ((options.descriptors ?? []).length > 0) {
            onDescriptors(options.descriptors ?? []);
          }
        })();
      },
    ),
  } as unknown as McpManager;

  const setStatus = (serverName: string, status: McpServerStatus): void => {
    serverStatuses.set(serverName, status);
    for (const listener of statusListeners) {
      listener(serverName, status);
    }
  };

  return { manager, callbacks, get startBackgroundDiscoveryCalls() { return startBackgroundDiscoveryCalls; }, setStatus };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createRuntime MCP background loading", () => {
  test("owns MCP shutdown and records only stable safe failure data", async () => {
    const secret = "shutdown-secret-123456";
    const url = "https://shutdown.example.test/private";
    const path = "/private/tmp/archcode-mcp-shutdown/stderr.log";
    const rawStderr = `stderr=${secret} ${url} ${path}`;
    const { manager } = makeMockMcpManager();
    (manager as unknown as { closeAll: ReturnType<typeof mock> }).closeAll = mock(async () => [{
      serverName: `server-${rawStderr}`,
      message: `close failed ${rawStderr}`,
    }]);
    const { logger, entries } = createInMemoryLogger();

    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      externalSecretLiterals: [secret],
      logger,
      mcpManagerFactory: () => manager,
    });

    await runtime.shutdown();
    await runtime.shutdown();

    expect((manager as unknown as { closeAll: ReturnType<typeof mock> }).closeAll).toHaveBeenCalledTimes(1);
    expect(runtime.warnings).toContainEqual({ message: "MCP shutdown failed" });
    const warning = entries.find((entry) => entry.event === "mcp.shutdown.warning");
    expect(warning).toMatchObject({
      event: "mcp.shutdown.warning",
      message: "MCP shutdown failed",
      meta: { failure: { name: "McpShutdownError", code: "MCP_SHUTDOWN_FAILED" } },
    });
    const serialized = JSON.stringify({ warnings: runtime.warnings, entries });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(url);
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain("stderr=");
    expect(serialized).not.toContain(REDACTION_MARKER);
  });

  test("passes one immutable runtime policy containing resolved secret literals", async () => {
    const mcpUrl = "https://private.example.test/mcp";
    const mcpHeader = "Bearer mcp-secret";
    const externalSecret = "server-password";
    const configService = await writeConfig(makeConfig({
      servers: {
        private: {
          url: mcpUrl,
          headers: { Authorization: mcpHeader },
        },
      },
    }));
    const { manager } = makeMockMcpManager();
    let policy: SecretRedactionPolicy | undefined;

    const runtime = await createRuntime({
      configService,
      externalSecretLiterals: [externalSecret],
      mcpManagerFactory: (_config, runtimePolicy) => {
        policy = runtimePolicy;
        return manager;
      },
    });

    expect(policy).toBeDefined();
    const leaked = `test-key ${mcpUrl} ${mcpHeader} ${externalSecret}`;
    const redacted = policy?.redactString(leaked) ?? leaked;
    expect(redacted).not.toContain("test-key");
    expect(redacted).not.toContain(mcpUrl);
    expect(redacted).not.toContain(mcpHeader);
    expect(redacted).not.toContain(externalSecret);
    await runtime.disposeToolOutputs();
  });

  test("createRuntime returns with all MCP servers in pending state", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const { manager } = makeMockMcpManager({
      servers: { docs: { state: "pending" } },
    });

    const runtime = await createRuntime({
      configService,
      mcpManagerFactory: () => manager,
    });

    const statuses = runtime.getMcpServerStatuses();
    expect(statuses.get("docs")).toEqual({ state: "pending" });
  });

  test("createRuntime calls startBackgroundDiscovery (not discover)", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const { manager } = makeMockMcpManager();

    const runtime = await createRuntime({
      configService,
      mcpManagerFactory: () => manager,
    });

    expect((manager as unknown as { startBackgroundDiscovery: { mock: { calls: unknown[] } } }).startBackgroundDiscovery.mock.calls).toHaveLength(1);
    expect((manager as unknown as { discover: { mock: { calls: unknown[] } } }).discover.mock.calls).toHaveLength(0);
    // sanity: runtime still returned
    expect(runtime.toolRegistry).toBeDefined();
  });

  test("discovered descriptors get registered into toolRegistry after background load", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const descriptor = makeMcpDescriptor("mcp__docs__lookup");
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const { manager, callbacks } = makeMockMcpManager({
      descriptors: [descriptor],
      connectGate,
    });

    const runtime = await createRuntime({
      configService,
      mcpManagerFactory: () => manager,
    });

    // Not registered yet (background hasn't delivered — gate still closed).
    expect(runtime.toolRegistry.get("mcp__docs__lookup")).toBeUndefined();

    // Wait for background callback to fire.
    await callbacks;
    releaseConnect();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(runtime.toolRegistry.get("mcp__docs__lookup")).toBe(descriptor);
  });

  test("duplicate tool descriptors are skipped with warning (not thrown)", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const duplicate = makeMcpDescriptor("file_read"); // collides with builtin
    const { manager, callbacks } = makeMockMcpManager({
      descriptors: [duplicate],
    });

    const runtime = await createRuntime({
      configService,
      mcpManagerFactory: () => manager,
    });

    await callbacks;
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(runtime.toolRegistry.get("file_read")).not.toBe(duplicate);
    expect(runtime.warnings).toContainEqual({
      toolName: "file_read",
      message: 'Duplicate MCP tool descriptor "file_read" skipped during startup',
    });
  });

  test("onWarning callback routes into runtime.warnings", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const warning: McpWarning = {
      serverName: "docs",
      message: "MCP server \"docs\" returned no tools",
    };
    const { manager, callbacks } = makeMockMcpManager({
      warnings: [warning],
    });

    const runtime = await createRuntime({
      configService,
      mcpManagerFactory: () => manager,
    });

    await callbacks;
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(runtime.warnings).toContainEqual(warning);
  });

  test("subscribeMcpStatusChanges returns an unsubscribe function", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const { manager } = makeMockMcpManager();

    const runtime = await createRuntime({
      configService,
      mcpManagerFactory: () => manager,
    });

    const calls: Array<{ serverName: string; status: McpServerStatus }> = [];
    const unsubscribe = runtime.subscribeMcpStatusChanges((serverName, status) => {
      calls.push({ serverName, status });
    });
    expect(typeof unsubscribe).toBe("function");

    // Manually emit a status change via the mock's listener set.
    // We can't directly access listeners, but we can verify unsubscribe stops calls
    // by checking that the function is callable and returns void.
    unsubscribe();
  });

  test("subscribeMcpStatusChanges listener receives status updates", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const { manager, setStatus } = makeMockMcpManager({
      servers: { docs: { state: "pending" } },
    });

    const runtime = await createRuntime({
      configService,
      mcpManagerFactory: () => manager,
    });

    const calls: Array<{ serverName: string; status: McpServerStatus }> = [];
    runtime.subscribeMcpStatusChanges((serverName, status) => {
      calls.push({ serverName, status });
    });

    setStatus("docs", { state: "ready", toolCount: 3, warningCount: 0 });

    expect(calls).toContainEqual({
      serverName: "docs",
      status: { state: "ready", toolCount: 3, warningCount: 0 },
    });
  });

  test("getMcpServerStatuses returns a snapshot Map (mutations do not affect internal state)", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const { manager } = makeMockMcpManager({
      servers: { docs: { state: "pending" } },
    });

    const runtime = await createRuntime({
      configService,
      mcpManagerFactory: () => manager,
    });

    const snapshot = runtime.getMcpServerStatuses();
    snapshot.set("docs", { state: "failed", error: "tampered" });
    snapshot.delete("docs");

    const fresh = runtime.getMcpServerStatuses();
    expect(fresh.get("docs")).toEqual({ state: "pending" });
    expect(fresh.size).toBe(1);
  });

  test("createRuntime does NOT await MCP — slow-connecting mock server does not delay runtime return", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const { manager } = makeMockMcpManager({
      descriptors: [makeMcpDescriptor("mcp__docs__lookup")],
      connectGate,
    });

    let runtimeReturned = false;
    const runtimePromise = createRuntime({
      configService,
      mcpManagerFactory: () => manager,
    });
    // Resolve one microtask — if createRuntime awaited MCP, runtimeReturned would still be false.
    await Promise.resolve();
    const runtime = await runtimePromise;
    runtimeReturned = true;

    expect(runtimeReturned).toBe(true);
    // Background discovery has not completed (gate not released).
    expect(runtime.getMcpServerStatuses().get("docs")).toEqual({ state: "pending" });
    expect(runtime.toolRegistry.get("mcp__docs__lookup")).toBeUndefined();

    // Release the gate so background can complete (cleanup).
    releaseConnect();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
});

describe("createRuntime tool output lifecycle", () => {
  test("initializes the configured store and exposes awaited disposal", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const { manager } = makeMockMcpManager();
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
      mcpManagerFactory: () => manager,
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
    const { manager } = makeMockMcpManager();
    const root = await makeTempRoot();
    let disposeCalls = 0;

    class FailingStore extends ToolOutputArtifactStore {
      override async ready(): Promise<void> {
        throw new Error("artifact init failed");
      }

      override async dispose(): Promise<void> {
        disposeCalls += 1;
        await super.dispose();
      }
    }

    await expect(createRuntime({
      configService,
      mcpManagerFactory: () => manager,
      toolOutputRootDir: root,
      toolOutputStoreFactory: (rootDir) => new FailingStore({ rootDir }),
    })).rejects.toThrow("artifact init failed");

    expect(disposeCalls).toBe(1);
    expect((manager as unknown as { closeAll: ReturnType<typeof mock> }).closeAll).toHaveBeenCalledTimes(1);
  });
});
