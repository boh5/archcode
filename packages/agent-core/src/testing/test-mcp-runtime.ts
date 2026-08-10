import type {
  McpServerInventoryResponse,
  McpServerStatus,
  McpServerStatusResponse,
  McpToolInventoryItem,
} from "@archcode/protocol";
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
  const listeners = new Set<McpStatusListener>();

  const runtime: TestMcpRuntime = {
    apply: options.apply ?? (async () => undefined),
    reconnect: options.reconnect ?? (async () => undefined),
    testServer: options.testServer ?? (async () => ({ tools: [], warnings: [] })),
    getStatus: () => cloneStatus(statusSnapshot),
    getInventory: () => cloneInventory(inventorySnapshot),
    snapshotTools: ({ builtinServerNames: _builtinServerNames }): McpToolSnapshot => ({
      descriptors: new Map(descriptors),
      statuses: cloneStatus(statusSnapshot),
    }),
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
