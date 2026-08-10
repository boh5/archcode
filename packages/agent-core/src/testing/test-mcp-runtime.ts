import type {
  BuiltinMcpServerName,
  McpServerInventoryResponse,
  McpServerStatus,
  McpServerStatusResponse,
  McpToolInventoryItem,
} from "@archcode/protocol";
import { BUILTIN_MCP_SERVER_NAMES } from "@archcode/protocol";
import type { ResolvedMcpConfig, ResolvedMcpServerConfig } from "../config/mcp";
import type {
  McpRuntime,
  McpStatusListener,
  McpTestResult,
  McpToolSnapshot,
} from "../mcp";
import type { AnyToolDescriptor } from "../tools/types";

export interface TestMcpRuntime extends McpRuntime {
  /** Replace the live status projection used by getStatus and snapshotTools. */
  setStatusSnapshot(status: McpServerStatusResponse): void;
  /** Emit one status transition to listeners registered through onStatusChange. */
  emitStatusChange(serverName: string, status: McpServerStatus): void;
}

export interface TestMcpRuntimeOptions {
  readonly statuses?: McpServerStatusResponse;
  readonly inventory?: McpServerInventoryResponse;
  readonly descriptors?: ReadonlyMap<string, AnyToolDescriptor>;
  readonly builtinDescriptors?: Readonly<Partial<Record<
    BuiltinMcpServerName,
    ReadonlyMap<string, AnyToolDescriptor>
  >>>;
  readonly apply?: (config: ResolvedMcpConfig) => Promise<void>;
  readonly reconnect?: (serverName: string) => Promise<void>;
  readonly testServer?: (
    serverName: string,
    config: ResolvedMcpServerConfig,
    options?: { signal?: AbortSignal },
  ) => Promise<McpTestResult>;
  readonly close?: () => Promise<void>;
}

/**
 * Minimal process-owned MCP fake for runtime tests. It models the new facade:
 * lifecycle methods, JSON status/inventory snapshots, and a run-local tool
 * snapshot; it intentionally has no discovery callbacks or global registry.
 */
export function createTestMcpRuntime(options: TestMcpRuntimeOptions = {}): TestMcpRuntime {
  let statusSnapshot: McpServerStatusResponse = cloneStatus(options.statuses ?? { servers: {} });
  const inventorySnapshot = cloneInventory(options.inventory ?? { servers: {} });
  const descriptors = new Map(options.descriptors ?? []);
  const builtinDescriptors = new Map(
    Object.entries(options.builtinDescriptors ?? {}).map(([name, entries]) => [
      name as BuiltinMcpServerName,
      new Map(entries ?? []),
    ]),
  );
  const listeners = new Set<McpStatusListener>();
  const builtinNames = new Set<string>(BUILTIN_MCP_SERVER_NAMES);

  const runtime: TestMcpRuntime = {
    apply: options.apply ?? (async () => undefined),
    reconnect: options.reconnect ?? (async () => undefined),
    testServer: options.testServer ?? (async () => ({ tools: [], warnings: [] })),
    getStatus: () => cloneStatus(statusSnapshot),
    getInventory: () => cloneInventory(inventorySnapshot),
    snapshotTools: ({ builtinServerNames }): McpToolSnapshot => {
      const allowedBuiltins = new Set<BuiltinMcpServerName>(builtinServerNames);
      const snapshotDescriptors = new Map(descriptors);
      for (const serverName of allowedBuiltins) {
        for (const [name, descriptor] of builtinDescriptors.get(serverName) ?? []) {
          snapshotDescriptors.set(name, descriptor);
        }
      }
      return {
        descriptors: snapshotDescriptors,
        statuses: {
          servers: Object.fromEntries(Object.entries(statusSnapshot.servers).filter(([name]) =>
            !builtinNames.has(name) || allowedBuiltins.has(name as BuiltinMcpServerName)
          ).map(([name, status]) => [name, { ...status }])),
        },
      };
    },
    onStatusChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: options.close ?? (async () => undefined),
    setStatusSnapshot: (next) => {
      statusSnapshot = cloneStatus(next);
    },
    emitStatusChange: (serverName, status) => {
      const next = { ...statusSnapshot.servers, [serverName]: { ...status } };
      statusSnapshot = { servers: next };
      for (const listener of listeners) listener(serverName, { ...status });
    },
  };
  return runtime;
}

function cloneStatus(snapshot: McpServerStatusResponse): McpServerStatusResponse {
  return {
    servers: Object.fromEntries(
      Object.entries(snapshot.servers).map(([name, status]) => [name, { ...status }]),
    ),
  };
}

function cloneInventory(snapshot: McpServerInventoryResponse): McpServerInventoryResponse {
  const servers: Record<string, McpToolInventoryItem[]> = {};
  for (const [name, tools] of Object.entries(snapshot.servers)) {
    servers[name] = tools.map((tool) => ({ ...tool }));
  }
  return { servers };
}
