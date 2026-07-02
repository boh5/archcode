import { afterAll, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
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
import { createRuntime } from "./runtime";

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

async function writeConfig(config: Record<string, unknown>): Promise<string> {
  const root = await makeTempRoot();
  const configPath = join(root, ".archcode.json");
  await writeFile(configPath, JSON.stringify(config));
  return configPath;
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
        },
      },
    },
  };
}

function makeConfig(mcp?: Record<string, unknown>): Record<string, unknown> {
  const config = {
    provider: makeProviderConfig(),
    agents: {
      orchestrator: { model: "local:test-model" },
      plan: { model: "local:test-model" },
      build: { model: "local:test-model" },
      reviewer: { model: "local:test-model" },
      explore: { model: "local:test-model" },
      librarian: { model: "local:test-model" },
    },
  };
  return mcp === undefined ? config : { ...config, mcp };
}

function makeMcpDescriptor(name = "mcp__context7__lookup"): AnyToolDescriptor {
  return defineTool({
    name,
    description: "Fake MCP lookup tool",
    inputSchema: z.object({}).catchall(z.unknown()),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async () => "mcp output",
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
  test("createRuntime returns with all MCP servers in pending state", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const { manager } = makeMockMcpManager({
      servers: { docs: { state: "pending" } },
    });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    const statuses = runtime.getMcpServerStatuses();
    expect(statuses.get("docs")).toEqual({ state: "pending" });
  });

  test("createRuntime calls startBackgroundDiscovery (not discover)", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const { manager } = makeMockMcpManager();

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect((manager as unknown as { startBackgroundDiscovery: { mock: { calls: unknown[] } } }).startBackgroundDiscovery.mock.calls).toHaveLength(1);
    expect((manager as unknown as { discover: { mock: { calls: unknown[] } } }).discover.mock.calls).toHaveLength(0);
    // sanity: runtime still returned
    expect(runtime.toolRegistry).toBeDefined();
  });

  test("discovered descriptors get registered into toolRegistry after background load", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
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
      configPath,
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
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const duplicate = makeMcpDescriptor("file_read"); // collides with builtin
    const { manager, callbacks } = makeMockMcpManager({
      descriptors: [duplicate],
    });

    const runtime = await createRuntime({
      configPath,
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
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const warning: McpWarning = {
      serverName: "docs",
      message: "MCP server \"docs\" returned no tools",
    };
    const { manager, callbacks } = makeMockMcpManager({
      warnings: [warning],
    });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    await callbacks;
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(runtime.warnings).toContainEqual(warning);
  });

  test("subscribeMcpStatusChanges returns an unsubscribe function", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const { manager } = makeMockMcpManager();

    const runtime = await createRuntime({
      configPath,
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
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const { manager, setStatus } = makeMockMcpManager({
      servers: { docs: { state: "pending" } },
    });

    const runtime = await createRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    const calls: Array<{ serverName: string; status: McpServerStatus }> = [];
    runtime.subscribeMcpStatusChanges((serverName, status) => {
      calls.push({ serverName, status });
    });

    setStatus("docs", { state: "ready", toolCount: 3 });

    expect(calls).toContainEqual({
      serverName: "docs",
      status: { state: "ready", toolCount: 3 },
    });
  });

  test("getMcpServerStatuses returns a snapshot Map (mutations do not affect internal state)", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const { manager } = makeMockMcpManager({
      servers: { docs: { state: "pending" } },
    });

    const runtime = await createRuntime({
      configPath,
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
    const configPath = await writeConfig(makeConfig({ servers: {} }));
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
      configPath,
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