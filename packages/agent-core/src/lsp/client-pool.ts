import { createLspClient, LspError, type LspClient, type LspInitializeOptions } from "./client";
import { createLspTransport, type StdioLspTransportOptions } from "./transport";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";

export interface PoolKey {
  workspaceRoot: string;
  serverId: string;
}

export interface LspClientPoolOptions {
  idleTimeoutMs?: number;
  crashWindowMs?: number;
  crashThreshold?: number;
  logger?: Logger;
}

export interface LspClientPoolAcquireOptions extends StdioLspTransportOptions {
  initializationOptions?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

export interface PoolEntry {
  client: LspClient | null;
  refCount: number;
  initializePromise: Promise<LspClient> | null;
  idleTimer: Timer | null;
  crashTimestamps: number[];
}

export interface TimerFns {
  setTimeout: (handler: () => void, timeout: number) => Timer;
  clearTimeout: (timer: Timer) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_CRASH_WINDOW_MS = 300_000;
const DEFAULT_CRASH_THRESHOLD = 3;

let timerFns: TimerFns = {
  setTimeout: (handler, timeout) => setTimeout(handler, timeout),
  clearTimeout: (timer) => clearTimeout(timer),
};

let lspClientPoolForTest: LspClientPool | undefined;

export function setTimerFnsForTest(fns: TimerFns | undefined): void {
  timerFns = fns ?? {
    setTimeout: (handler, timeout) => setTimeout(handler, timeout),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

export function setLspClientPoolForTest(pool: LspClientPool | undefined): void {
  lspClientPoolForTest = pool;
}

export function getLspClientPool(): LspClientPool {
  if (lspClientPoolForTest) return lspClientPoolForTest;
  return defaultPool;
}

export function createLspClientPool(options?: LspClientPoolOptions): LspClientPool {
  return new LspClientPool(options);
}

export class LspClientPool {
  private readonly idleTimeoutMs: number;
  private readonly crashWindowMs: number;
  private readonly crashThreshold: number;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly crashHistory = new Map<string, number[]>();
  private readonly shutdownKeys = new Set<string>();
  #logger: Logger;

  constructor(options: LspClientPoolOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
    this.crashThreshold = options.crashThreshold ?? DEFAULT_CRASH_THRESHOLD;
    this.#logger = (options.logger ?? silentLogger).child({ module: "lsp.pool" });
  }

  setLogger(logger: Logger): void {
    this.#logger = logger.child({ module: "lsp.pool" });
  }

  async acquire(key: PoolKey, serverOptions: LspClientPoolAcquireOptions): Promise<LspClient> {
    const id = poolKeyToString(key);
    this.assertNotCrashLooping(id, key);

    const existing = this.entries.get(id);
    if (existing) {
      existing.refCount += 1;
      this.clearIdleTimer(existing);
      try {
        return existing.client ?? await existing.initializePromise!;
      } catch (error) {
        this.releaseRefAfterFailedAcquire(id, existing);
        throw error;
      }
    }

    const entry: PoolEntry = {
      client: null,
      refCount: 1,
      initializePromise: null,
      idleTimer: null,
      crashTimestamps: this.currentCrashTimestamps(id),
    };
    this.entries.set(id, entry);

    const transport = createLspTransport({
      ...serverOptions,
      captureStderr: serverOptions.captureStderr ?? true,
      logger: this.#logger.child({ module: "lsp.transport" }),
    });
    entry.initializePromise = (async () => {
      const client = createLspClient({
        transport,
        workspaceRoot: key.workspaceRoot,
        timeouts: serverOptions.timeouts,
        logger: this.#logger.child({ module: "lsp.client" }),
      });
      try {
        await client.initialize(key.workspaceRoot, initializeOptionsFromServerOptions(serverOptions));
        entry.client = client;
        this.watchForCrash(id, entry, transport);
        return client;
      } catch (error) {
        this.#logger.error("lsp.pool.acquire.failed", {
          context: { serverId: id },
          error,
          meta: { ...errorFields(error), ...stderrFields(transport) },
        });
        await ignoreErrors(client.shutdown());
        this.entries.delete(id);
        throw error;
      }
    })();

    try {
      return await entry.initializePromise;
    } finally {
      entry.initializePromise = null;
    }
  }

  release(key: PoolKey): void {
    const id = poolKeyToString(key);
    const entry = this.entries.get(id);
    if (!entry) return;

    try {
      if (entry.refCount > 0) {
        entry.refCount -= 1;
      }
    } finally {
      if (entry.refCount === 0 && !entry.idleTimer) {
        entry.idleTimer = timerFns.setTimeout(() => {
          void this.shutdownAndEvict(id, entry);
        }, this.idleTimeoutMs);
      }
    }
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.entries.entries()];
    this.entries.clear();

    await Promise.all(entries.map(async ([id, entry]) => {
      this.clearIdleTimer(entry);
      this.shutdownKeys.add(id);
      const client = entry.client ?? await entry.initializePromise?.catch(() => null) ?? null;
      if (client) await ignoreErrors(client.shutdown());
      this.shutdownKeys.delete(id);
    }));
  }

  getRefCountForTest(key: PoolKey): number {
    return this.entries.get(poolKeyToString(key))?.refCount ?? 0;
  }

  hasEntryForTest(key: PoolKey): boolean {
    return this.entries.has(poolKeyToString(key));
  }

  private async shutdownAndEvict(id: string, entry: PoolEntry): Promise<void> {
    if (this.entries.get(id) !== entry || entry.refCount > 0) return;

    this.#logger.debug("lsp.pool.evict.idle", { context: { serverId: id } });
    this.entries.delete(id);
    this.clearIdleTimer(entry);
    this.shutdownKeys.add(id);
    try {
      const client = entry.client ?? await entry.initializePromise?.catch(() => null) ?? null;
      if (client) await ignoreErrors(client.shutdown());
    } finally {
      this.shutdownKeys.delete(id);
    }
  }

  private watchForCrash(id: string, entry: PoolEntry, transport: unknown): void {
    const exited = getExitedPromise(transport);
    if (!exited) return;

    exited.then((code) => {
      if (code === 0 || this.shutdownKeys.has(id)) return;
      if (this.entries.get(id) !== entry) return;

      this.#logger.error("lsp.pool.crash.detected", {
        context: { serverId: id, exitCode: code },
        meta: stderrFields(transport),
      });
      this.entries.delete(id);
      this.clearIdleTimer(entry);
      this.recordCrash(id);
    }).catch(() => {
      if (this.shutdownKeys.has(id) || this.entries.get(id) !== entry) return;
      this.#logger.error("lsp.pool.crash.detected", {
        context: { serverId: id, exitCode: undefined },
        meta: stderrFields(transport),
      });
      this.entries.delete(id);
      this.clearIdleTimer(entry);
      this.recordCrash(id);
    });
  }

  private recordCrash(id: string): void {
    const crashes = [...this.currentCrashTimestamps(id), Date.now()];
    this.crashHistory.set(id, crashes);
    if (crashes.length >= this.crashThreshold) {
      this.crashHistory.set(id, crashes);
    }
  }

  private assertNotCrashLooping(id: string, key: PoolKey): void {
    const crashes = this.currentCrashTimestamps(id);
    this.crashHistory.set(id, crashes);
    if (crashes.length < this.crashThreshold) return;

    throw new LspError({
      code: -32000,
      message: `LSP server "${key.serverId}" for workspace "${key.workspaceRoot}" crashed ${crashes.length} times within ${this.crashWindowMs}ms. The server may be misconfigured or incompatible; inspect its command, arguments, and logs before retrying.`,
    });
  }

  private currentCrashTimestamps(id: string): number[] {
    const cutoff = Date.now() - this.crashWindowMs;
    return (this.crashHistory.get(id) ?? []).filter((timestamp) => timestamp >= cutoff);
  }

  private releaseRefAfterFailedAcquire(id: string, entry: PoolEntry): void {
    if (this.entries.get(id) !== entry) return;
    if (entry.refCount > 0) entry.refCount -= 1;
    if (entry.refCount === 0) this.entries.delete(id);
  }

  private clearIdleTimer(entry: PoolEntry): void {
    if (!entry.idleTimer) return;
    timerFns.clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function initializeOptionsFromServerOptions(serverOptions: LspClientPoolAcquireOptions): LspInitializeOptions | undefined {
  if (!serverOptions.initializationOptions && !serverOptions.capabilities) return undefined;
  return {
    ...(serverOptions.initializationOptions ? { initializationOptions: serverOptions.initializationOptions } : {}),
    ...(serverOptions.capabilities ? { capabilities: serverOptions.capabilities } : {}),
  };
}

function poolKeyToString(key: PoolKey): string {
  return `${key.workspaceRoot}::${key.serverId}`;
}

function getExitedPromise(transport: unknown): Promise<number> | undefined {
  if (!isRecord(transport)) return undefined;
  const exited = transport.exited;
  return exited && typeof exited === "object" && typeof (exited as Promise<number>).then === "function"
    ? exited as Promise<number>
    : undefined;
}

function stderrFields(transport: unknown): Record<string, unknown> {
  if (!isRecord(transport) || typeof transport.stderrSnapshot !== "string" || transport.stderrSnapshot.length === 0) {
    return {};
  }
  return { lspStderr: transport.stderrSnapshot };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function ignoreErrors(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Pool cleanup must be best-effort.
  }
}

function errorFields(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message };
  return { errorName: "NonError", errorMessage: String(error) };
}

const defaultPool = new LspClientPool();

export function configureDefaultLspClientPoolLogger(logger: Logger): void {
  defaultPool.setLogger(logger);
}
