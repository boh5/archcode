import type {
  BuiltinMcpServerName,
  McpServerInventoryResponse,
  McpServerStatus,
  McpServerStatusResponse,
  McpToolInventoryItem,
} from "@archcode/protocol";
import type { ResolvedMcpConfig, ResolvedMcpServerConfig } from "../config/mcp";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { SecretRedactionPolicy } from "../security";
import type { AnyToolDescriptor } from "../tools/types";
import { BUILTIN_MCP_SERVERS } from "./builtin-servers";
import {
  createDefaultMcpClientFactories,
  McpClient,
  type McpClientFactories,
  type McpToolLike,
} from "./client";
import { adaptMcpTool, type McpCallLease } from "./tool-adapter";
import { toMcpToolRegistryName } from "./naming";

export type McpStatusListener = (serverName: string, status: McpServerStatus) => void;

export interface McpToolSnapshot {
  /** Run-local map. Keep this exact map for every tool call from the model step. */
  readonly descriptors: ReadonlyMap<string, AnyToolDescriptor>;
  /** Status projection captured in the same synchronous snapshot as descriptors. */
  readonly statuses: McpServerStatusResponse;
}

export interface McpTestResult {
  readonly tools: McpToolInventoryItem[];
  readonly warnings: string[];
}

export const MAX_CONCURRENT_MCP_DRAFT_TESTS = 8;

export interface McpRuntimeServiceOptions {
  readonly builtinServers?: Readonly<Partial<Record<BuiltinMcpServerName, ResolvedMcpServerConfig>>>;
  readonly clientFactories?: McpClientFactories;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly createRedactionPolicy?: (config: ResolvedMcpServerConfig) => SecretRedactionPolicy;
}

/** Narrow process-owned MCP lifecycle used by AgentRuntime and its test seams. */
export interface McpRuntime {
  apply(config: ResolvedMcpConfig): Promise<void>;
  reconnect(serverName: string): Promise<void>;
  testServer(
    serverName: string,
    config: ResolvedMcpServerConfig,
    options?: { signal?: AbortSignal },
  ): Promise<McpTestResult>;
  getStatus(): McpServerStatusResponse;
  getInventory(): McpServerInventoryResponse;
  snapshotTools(options: {
    builtinServerNames: readonly BuiltinMcpServerName[];
  }): McpToolSnapshot;
  onStatusChange(listener: McpStatusListener): () => void;
  close(): Promise<void>;
}

interface DesiredServer {
  readonly source: "builtin" | "user";
  readonly config: ResolvedMcpServerConfig;
  readonly fingerprint: string;
}

interface Candidate {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly handle: McpServerHandle;
}

interface DraftTestFlight {
  readonly controller: AbortController;
  handle?: McpServerHandle;
  promise?: Promise<McpTestResult>;
}

interface ServerToolProjection {
  readonly descriptors: ReadonlyMap<string, AnyToolDescriptor>;
  readonly inventory: readonly McpToolInventoryItem[];
  readonly warningCount: number;
}

/** Global live MCP owner with no Session, Execution, Agent, Registry, permission, retry, or persistence dependency. */
export class McpRuntimeService implements McpRuntime {
  readonly #builtinServers: Readonly<Partial<Record<BuiltinMcpServerName, ResolvedMcpServerConfig>>>;
  readonly #clientFactories: McpClientFactories;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #createRedactionPolicy: (config: ResolvedMcpServerConfig) => SecretRedactionPolicy;
  readonly #desired = new Map<string, DesiredServer>();
  readonly #epochs = new Map<string, number>();
  readonly #handles = new Map<string, McpServerHandle>();
  readonly #candidates = new Map<string, Candidate>();
  readonly #statuses = new Map<string, McpServerStatus>();
  readonly #listeners = new Set<McpStatusListener>();
  readonly #reconnectFlights = new Map<string, Promise<void>>();
  readonly #testsInFlight = new Map<string, DraftTestFlight>();
  #configuredUsers = new Set<string>();
  #closed = false;

  constructor(options: McpRuntimeServiceOptions = {}) {
    this.#builtinServers = options.builtinServers ?? BUILTIN_MCP_SERVERS;
    this.#clientFactories = options.clientFactories ?? createDefaultMcpClientFactories();
    this.#logger = (options.logger ?? silentLogger).child({ module: "mcp.runtime" });
    this.#now = options.now ?? Date.now;
    this.#createRedactionPolicy = options.createRedactionPolicy ?? createServerRedactionPolicy;
  }

  /** Retire/status transitions happen before the first await; async publication is epoch fenced. */
  async apply(config: ResolvedMcpConfig): Promise<void> {
    this.#assertOpen();
    const previousConfiguredUsers = this.#configuredUsers;
    const next = this.#buildDesired(config);
    const nextConfiguredUsers = new Set(Object.keys(config.servers));
    const nextDisabledBuiltins = new Set(config.disabledBuiltins);
    const names = new Set([
      ...this.#desired.keys(),
      ...next.keys(),
      ...this.#candidates.keys(),
      ...this.#configuredUsers,
      ...nextConfiguredUsers,
      ...Object.keys(this.#builtinServers),
    ]);
    this.#configuredUsers = nextConfiguredUsers;
    const connects: Promise<void>[] = [];

    for (const serverName of names) {
      const previous = this.#desired.get(serverName);
      const desired = next.get(serverName);
      if (previous && desired && previous.fingerprint === desired.fingerprint) continue;
      if (!previous && !desired) {
        const disabled = nextDisabledBuiltins.has(serverName as BuiltinMcpServerName)
          || config.servers[serverName]?.enabled === false;
        if (disabled) {
          this.#publishStatus(serverName, { state: "disabled", updatedAt: this.#now() });
          continue;
        }
        if (previousConfiguredUsers.has(serverName) && !nextConfiguredUsers.has(serverName)) {
          this.#publishStatus(serverName, { state: "disabled", updatedAt: this.#now() });
          this.#statuses.delete(serverName);
        }
        continue;
      }

      const epoch = this.#advanceEpoch(serverName);
      this.#retireCurrent(serverName);
      if (!desired) {
        this.#desired.delete(serverName);
        const disabled: McpServerStatus = { state: "disabled", updatedAt: this.#now() };
        this.#publishStatus(serverName, disabled);
        if (!this.#isConfiguredBuiltin(serverName) && !this.#configuredUsers.has(serverName)) {
          this.#statuses.delete(serverName);
        }
        continue;
      }

      this.#desired.set(serverName, desired);
      this.#publishStatus(serverName, { state: "connecting", startedAt: this.#now() });
      connects.push(this.#startConnection(serverName, desired, epoch));
    }

    await Promise.allSettled(connects);
  }

  reconnect(serverName: string): Promise<void> {
    this.#assertOpen();
    const active = this.#reconnectFlights.get(serverName);
    if (active) return active;
    const desired = this.#desired.get(serverName);
    if (!desired) throw new Error(`MCP server "${serverName}" is disabled or not configured`);
    const epoch = this.#advanceEpoch(serverName);
    this.#retireCurrent(serverName);
    this.#publishStatus(serverName, { state: "connecting", startedAt: this.#now() });
    const flight = this.#startConnection(serverName, desired, epoch).finally(() => {
      if (this.#reconnectFlights.get(serverName) === flight) this.#reconnectFlights.delete(serverName);
    });
    this.#reconnectFlights.set(serverName, flight);
    return flight;
  }

  async testServer(
    serverName: string,
    config: ResolvedMcpServerConfig,
    options: { signal?: AbortSignal } = {},
  ): Promise<McpTestResult> {
    this.#assertOpen();
    const testKey = `${serverName}:${stableSerialize(config)}`;
    if (this.#testsInFlight.has(testKey)) {
      throw new Error(`MCP server test already in progress for "${serverName}"`);
    }
    if (this.#testsInFlight.size >= MAX_CONCURRENT_MCP_DRAFT_TESTS) {
      throw new Error(`At most ${MAX_CONCURRENT_MCP_DRAFT_TESTS} MCP server tests may run concurrently`);
    }
    const controller = new AbortController();
    const removeAbortForwarder = forwardAbort(options.signal, controller);
    const flight: DraftTestFlight = { controller };
    const promise = this.#runDraftTest(serverName, config, flight).finally(() => {
      removeAbortForwarder();
      if (this.#testsInFlight.get(testKey) === flight) this.#testsInFlight.delete(testKey);
    });
    flight.promise = promise;
    this.#testsInFlight.set(testKey, flight);
    return await promise;
  }

  async #runDraftTest(
    serverName: string,
    config: ResolvedMcpServerConfig,
    flight: DraftTestFlight,
  ): Promise<McpTestResult> {
    try {
      const policy = this.#createRedactionPolicy(config);
      const client = new McpClient(serverName, config, policy, this.#clientFactories, this.#logger);
      const handle = new McpServerHandle(client, policy);
      flight.handle = handle;
      client.onUnexpectedFailure((error) => {
        flight.controller.abort(error);
        void handle.retire().catch((closeError) => {
          this.#logCloseFailure(serverName, closeError, policy);
        });
      });
      await client.connect(flight.controller.signal);
      const tools = await client.listTools(flight.controller.signal);
      const projection = projectServerTools(serverName, tools, handle, policy, this.#logger);
      return {
        tools: [...projection.inventory],
        warnings: projection.warningCount === 0
          ? []
          : [`${projection.warningCount} duplicate or invalid MCP tools were omitted`],
      };
    } finally {
      if (flight.handle) {
        await flight.handle.retire().catch((error) => {
          this.#logCloseFailure(serverName, error, flight.handle?.redactionPolicy);
        });
      }
    }
  }

  getStatus(): McpServerStatusResponse {
    return { servers: Object.fromEntries([...this.#statuses].map(([name, status]) => [name, { ...status }])) };
  }

  getInventory(): McpServerInventoryResponse {
    const servers: Record<string, McpToolInventoryItem[]> = {};
    for (const [serverName, handle] of this.#handles) {
      servers[serverName] = handle.inventory.map((item) => ({ ...item }));
    }
    return { servers };
  }

  snapshotTools(options: { builtinServerNames: readonly BuiltinMcpServerName[] }): McpToolSnapshot {
    const allowedBuiltins = new Set(options.builtinServerNames);
    const descriptors = new Map<string, AnyToolDescriptor>();
    const statuses: Record<string, McpServerStatus> = {};

    for (const [serverName, status] of this.#statuses) {
      const isBuiltin = this.#isConfiguredBuiltin(serverName);
      if (isBuiltin && !allowedBuiltins.has(serverName as BuiltinMcpServerName)) continue;
      if (!isBuiltin && !this.#configuredUsers.has(serverName)) continue;
      statuses[serverName] = { ...status };
    }
    for (const [serverName, desired] of this.#desired) {
      if (desired.source === "builtin" && !allowedBuiltins.has(serverName as BuiltinMcpServerName)) continue;
      const status = this.#statuses.get(serverName);
      if (!status || status.state !== "ready") continue;
      const handle = this.#handles.get(serverName);
      if (!handle) continue;
      for (const [alias, descriptor] of handle.descriptors) descriptors.set(alias, descriptor);
    }

    return { descriptors, statuses: { servers: statuses } };
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const retiring: Promise<void>[] = [];
    const draftTests = [...this.#testsInFlight.values()];
    for (const flight of draftTests) {
      flight.controller.abort();
      if (flight.handle) {
        retiring.push(flight.handle.retire().catch((error) => {
          this.#logCloseFailure("draft-test", error, flight.handle?.redactionPolicy);
        }));
      }
      if (flight.promise) retiring.push(flight.promise.then(() => undefined, () => undefined));
    }
    const names = new Set([...this.#desired.keys(), ...this.#candidates.keys(), ...this.#handles.keys()]);
    for (const serverName of names) {
      this.#advanceEpoch(serverName);
      const candidate = this.#candidates.get(serverName);
      if (candidate) {
        candidate.controller.abort();
        this.#candidates.delete(serverName);
        retiring.push(candidate.handle.retire().catch((error) => {
          this.#logCloseFailure(serverName, error, candidate.handle.redactionPolicy);
        }));
      }
      const handle = this.#handles.get(serverName);
      if (handle) {
        this.#handles.delete(serverName);
        retiring.push(handle.retire().catch((error) => {
          this.#logCloseFailure(serverName, error, handle.redactionPolicy);
        }));
      }
    }
    this.#desired.clear();
    this.#configuredUsers.clear();
    await Promise.allSettled(retiring);
    this.#listeners.clear();
  }

  #buildDesired(config: ResolvedMcpConfig): Map<string, DesiredServer> {
    const desired = new Map<string, DesiredServer>();
    const disabledBuiltins = new Set(config.disabledBuiltins);
    for (const [serverName, serverConfig] of Object.entries(this.#builtinServers)) {
      if (disabledBuiltins.has(serverName as BuiltinMcpServerName)) continue;
      desired.set(serverName, desiredServer("builtin", serverConfig));
    }
    for (const [serverName, serverConfig] of Object.entries(config.servers)) {
      if (!serverConfig.enabled) continue;
      desired.set(serverName, desiredServer("user", serverConfig));
    }
    return desired;
  }

  #startConnection(serverName: string, desired: DesiredServer, epoch: number): Promise<void> {
    let policy: SecretRedactionPolicy | undefined;
    try {
      policy = this.#createRedactionPolicy(desired.config);
      const client = new McpClient(serverName, desired.config, policy, this.#clientFactories, this.#logger);
      const candidate: Candidate = {
        epoch,
        controller: new AbortController(),
        handle: new McpServerHandle(client, policy),
      };
      this.#candidates.set(serverName, candidate);
      client.onUnexpectedFailure((error) => {
        this.#handleUnexpectedFailure(serverName, candidate.handle, error);
      });
      return this.#connectAndPublish(serverName, desired, candidate, policy);
    } catch (error) {
      if (this.#isWinning(serverName, desired, epoch)) this.#publishFailed(serverName, error, policy);
      return Promise.resolve();
    }
  }

  async #connectAndPublish(
    serverName: string,
    desired: DesiredServer,
    candidate: Candidate,
    policy: SecretRedactionPolicy,
  ): Promise<void> {
    try {
      await candidate.handle.client.connect(candidate.controller.signal);
      const tools = await candidate.handle.client.listTools(candidate.controller.signal);
      const projection = projectServerTools(serverName, tools, candidate.handle, policy, this.#logger);
      if (!this.#isWinning(serverName, desired, candidate.epoch) || this.#closed) {
        await candidate.handle.retire().catch((closeError) => {
          this.#logCloseFailure(serverName, closeError, policy);
        });
        return;
      }
      candidate.handle.publish(projection);
      this.#candidates.delete(serverName);
      this.#handles.set(serverName, candidate.handle);
      this.#publishStatus(serverName, {
        state: "ready",
        toolCount: projection.descriptors.size,
        warningCount: projection.warningCount,
        connectedAt: this.#now(),
      });
    } catch (error) {
      await candidate.handle.retire().catch((closeError) => this.#logCloseFailure(serverName, closeError, policy));
      if (!this.#isWinning(serverName, desired, candidate.epoch) || this.#closed) return;
      this.#candidates.delete(serverName);
      this.#publishFailed(serverName, error, policy);
    }
  }

  #publishFailed(
    serverName: string,
    error: unknown,
    policy?: SecretRedactionPolicy,
  ): void {
    const message = policy === undefined
      ? "MCP server failed before a safe secret redaction policy could be created"
      : policy.redactString(errorMessage(error));
    this.#logger.warn("mcp.runtime.connect.failed", {
      context: { serverName },
      error: { name: errorName(error), message },
    });
    this.#publishStatus(serverName, { state: "failed", error: message, failedAt: this.#now() });
  }

  #handleUnexpectedFailure(
    serverName: string,
    handle: McpServerHandle,
    error: Error,
  ): void {
    const candidate = this.#candidates.get(serverName);
    const isCandidate = candidate?.handle === handle;
    const isReady = this.#handles.get(serverName) === handle;
    if ((!isCandidate && !isReady) || this.#closed) return;

    this.#advanceEpoch(serverName);
    if (isCandidate) {
      candidate.controller.abort();
      this.#candidates.delete(serverName);
    }
    if (isReady) this.#handles.delete(serverName);
    void handle.retire().catch((closeError) => {
      this.#logCloseFailure(serverName, closeError, handle.redactionPolicy);
    });
    this.#publishFailed(serverName, error, handle.redactionPolicy);
  }

  #retireCurrent(serverName: string): void {
    const candidate = this.#candidates.get(serverName);
    if (candidate) {
      candidate.controller.abort();
      this.#candidates.delete(serverName);
      void candidate.handle.retire().catch((error) => {
        this.#logCloseFailure(serverName, error, candidate.handle.redactionPolicy);
      });
    }
    const handle = this.#handles.get(serverName);
    if (handle) {
      this.#handles.delete(serverName);
      void handle.retire().catch((error) => {
        this.#logCloseFailure(serverName, error, handle.redactionPolicy);
      });
    }
  }

  #isWinning(serverName: string, desired: DesiredServer, epoch: number): boolean {
    return this.#epochs.get(serverName) === epoch
      && this.#desired.get(serverName)?.fingerprint === desired.fingerprint;
  }

  #advanceEpoch(serverName: string): number {
    const next = (this.#epochs.get(serverName) ?? 0) + 1;
    this.#epochs.set(serverName, next);
    return next;
  }

  #publishStatus(serverName: string, status: McpServerStatus): void {
    this.#statuses.set(serverName, status);
    for (const listener of this.#listeners) {
      try {
        listener(serverName, { ...status });
      } catch (error) {
        this.#logger.warn("mcp.runtime.listener.failed", {
          context: { serverName },
          error: { name: errorName(error), message: errorMessage(error) },
        });
      }
    }
  }

  #logCloseFailure(serverName: string, error: unknown, policy?: SecretRedactionPolicy): void {
    this.#logger.warn("mcp.runtime.close.failed", {
      context: { serverName },
      error: {
        name: errorName(error),
        message: policy?.redactString(errorMessage(error)) ?? "MCP server close failed",
      },
    });
  }

  #isConfiguredBuiltin(serverName: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.#builtinServers, serverName);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("MCP runtime service is closed");
  }
}

class McpServerHandle {
  descriptors: ReadonlyMap<string, AnyToolDescriptor> = new Map();
  inventory: readonly McpToolInventoryItem[] = [];
  #retired = false;
  #inFlight = 0;
  #retirePromise?: Promise<void>;
  #resolveRetire?: () => void;
  #rejectRetire?: (error: unknown) => void;
  #closeStarted = false;

  constructor(
    readonly client: McpClient,
    readonly redactionPolicy: SecretRedactionPolicy,
  ) {}

  publish(projection: ServerToolProjection): void {
    this.descriptors = projection.descriptors;
    this.inventory = projection.inventory;
  }

  tryAcquireCall(): McpCallLease | undefined {
    if (this.#retired) return undefined;
    this.#inFlight += 1;
    let released = false;
    return {
      client: this.client,
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight -= 1;
        if (this.#retired && this.#inFlight === 0) this.#beginClose();
      },
    };
  }

  retire(): Promise<void> {
    if (!this.#retirePromise) {
      this.#retired = true;
      this.#retirePromise = new Promise<void>((resolve, reject) => {
        this.#resolveRetire = resolve;
        this.#rejectRetire = reject;
      });
      if (this.#inFlight === 0) this.#beginClose();
    }
    return this.#retirePromise;
  }

  #beginClose(): void {
    if (this.#closeStarted) return;
    this.#closeStarted = true;
    void this.client.close().then(
      () => this.#resolveRetire?.(),
      (error) => this.#rejectRetire?.(error),
    );
  }
}

function projectServerTools(
  serverName: string,
  tools: readonly McpToolLike[],
  handle: McpServerHandle,
  policy: SecretRedactionPolicy,
  logger: Logger,
): ServerToolProjection {
  const descriptors = new Map<string, AnyToolDescriptor>();
  const inventory: McpToolInventoryItem[] = [];
  let warningCount = 0;
  for (const tool of tools) {
    try {
      const safeTool = policy.redactValue(tool);
      const alias = toMcpToolRegistryName(serverName, tool.name, safeTool.name);
      if (descriptors.has(alias)) {
        warningCount += 1;
        continue;
      }
      const descriptor = adaptMcpTool(safeTool, serverName, handle, policy, logger, {
        rawName: tool.name,
        registryName: alias,
      });
      descriptors.set(alias, descriptor);
      inventory.push({
        serverName,
        name: safeTool.name,
        registryName: alias,
        ...(safeTool.description === undefined ? {} : { description: safeTool.description }),
      });
    } catch (error) {
      warningCount += 1;
      logger.warn("mcp.runtime.tool.omitted", {
        context: { serverName, toolName: policy.redactString(tool.name) },
        error: { name: errorName(error), message: policy.redactString(errorMessage(error)) },
      });
    }
  }
  return { descriptors, inventory, warningCount };
}

function desiredServer(source: DesiredServer["source"], config: ResolvedMcpServerConfig): DesiredServer {
  return { source, config, fingerprint: `${source}:${stableSerialize(config)}` };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createServerRedactionPolicy(config: ResolvedMcpServerConfig): SecretRedactionPolicy {
  const candidates = config.type === "http"
    ? Object.values(config.headers ?? {})
    : Object.values(config.env ?? {});
  return new SecretRedactionPolicy(candidates);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown MCP runtime error";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
