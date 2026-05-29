import { afterEach, describe, expect, test } from "bun:test";
import { LspClient, LspError, setLspClientForTest } from "./client";
import {
  LspClientPool,
  getLspClientPool,
  setLspClientPoolForTest,
  setTimerFnsForTest,
  type PoolKey,
  type TimerFns,
} from "./client-pool";
import { LspInstallerError, setInstallerProcessRunnerForTest, type ExecCommand } from "./installer";
import { setLspTransportForTest, type LspTransport, type StdioLspTransportOptions } from "./transport";
import type { Disposable } from "vscode-jsonrpc";

afterEach(() => {
  setLspClientForTest(undefined);
  setLspTransportForTest(undefined);
  setLspClientPoolForTest(undefined);
  setInstallerProcessRunnerForTest(undefined);
  setTimerFnsForTest(undefined);
});

describe("LspClientPool", () => {
  test("10 concurrent acquires for same server share one initialize", async () => {
    const seam = installMockClientSeam({ initializeDelayMs: 5 });
    const pool = new LspClientPool({ idleTimeoutMs: 1_000 });
    const key = poolKey("/workspace", "typescript");

    const clients = await Promise.all(
      Array.from({ length: 10 }, () => pool.acquire(key, serverOptions())),
    );

    expect(new Set(clients).size).toBe(1);
    expect(seam.transports.length).toBe(1);
    expect(seam.clients[0].initializeCount).toBe(1);
    expect(pool.getRefCountForTest(key)).toBe(10);

    clients.forEach(() => pool.release(key));
    await pool.disposeAll();
  });

  test("forwards capabilities and initializationOptions to client initialize once", async () => {
    const seam = installMockClientSeam();
    const pool = new LspClientPool();
    const key = poolKey("/workspace", "typescript");

    await pool.acquire(key, {
      ...serverOptions(),
      capabilities: { textDocument: { hover: { dynamicRegistration: false } } },
      initializationOptions: { tsserver: { path: "/tmp/tsserver.js" } },
    });

    expect(seam.clients[0].initializeOptions).toEqual({
      capabilities: { textDocument: { hover: { dynamicRegistration: false } } },
      initializationOptions: { tsserver: { path: "/tmp/tsserver.js" } },
    });
    pool.release(key);
    await pool.disposeAll();
  });

  test("resolves server binary before creating transport and preserves args", async () => {
    const seam = installMockClientSeam();
    const calls: CallRecord[] = [];
    setInstallerProcessRunnerForTest(createSpawnFromExec(async (command) => {
      calls.push({ command });
      return { stdout: "/fake/bin/typescript-language-server\n", stderr: "", exitCode: 0 };
    }));
    const pool = new LspClientPool();
    const key = poolKey("/workspace", "typescript");

    await pool.acquire(key, { ...serverOptions(), args: ["--stdio"] });

    expect(calls.map((call) => call.command.join(" "))).toEqual(["which typescript-language-server"]);
    expect(seam.transportOptions[0]).toMatchObject({
      command: "/fake/bin/typescript-language-server",
      args: ["--stdio"],
    });
    pool.release(key);
    await pool.disposeAll();
  });

  test("pool key uses workspaceRoot and serverId without cross sharing", async () => {
    installMockClientSeam();
    const pool = new LspClientPool();
    const sameWorkspaceTs = poolKey("/workspace", "typescript");
    const sameWorkspaceRust = poolKey("/workspace", "rust");
    const otherWorkspaceTs = poolKey("/other", "typescript");

    const clients = await Promise.all([
      pool.acquire(sameWorkspaceTs, serverOptions()),
      pool.acquire(sameWorkspaceRust, serverOptions()),
      pool.acquire(otherWorkspaceTs, serverOptions()),
    ]);

    expect(new Set(clients).size).toBe(3);

    pool.release(sameWorkspaceTs);
    pool.release(sameWorkspaceRust);
    pool.release(otherWorkspaceTs);
    await pool.disposeAll();
  });

  test("acquire and release cycle returns ref count to zero", async () => {
    installMockClientSeam();
    const timers = new FakeTimers();
    setTimerFnsForTest(timers.fns);
    const pool = new LspClientPool({ idleTimeoutMs: 50 });
    const key = poolKey("/workspace", "typescript");

    await pool.acquire(key, serverOptions());
    await pool.acquire(key, serverOptions());
    expect(pool.getRefCountForTest(key)).toBe(2);

    pool.release(key);
    pool.release(key);

    expect(pool.getRefCountForTest(key)).toBe(0);
    expect(timers.pendingCount).toBe(1);
    await pool.disposeAll();
  });

  test("idle timer shuts down and evicts client after timeout", async () => {
    const seam = installMockClientSeam();
    const timers = new FakeTimers();
    setTimerFnsForTest(timers.fns);
    const pool = new LspClientPool({ idleTimeoutMs: 50 });
    const key = poolKey("/workspace", "typescript");

    await pool.acquire(key, serverOptions());
    pool.release(key);

    expect(pool.hasEntryForTest(key)).toBe(true);
    await timers.runNext();

    expect(pool.hasEntryForTest(key)).toBe(false);
    expect(seam.clients[0].shutdownCount).toBe(1);
  });

  test("crashed server is evicted and next acquire re-spawns", async () => {
    const seam = installMockClientSeam();
    const pool = new LspClientPool({ crashThreshold: 3, crashWindowMs: 300_000 });
    const key = poolKey("/workspace", "typescript");

    const first = await pool.acquire(key, serverOptions());
    seam.transports[0].crash(1);
    await Promise.resolve();

    expect(pool.hasEntryForTest(key)).toBe(false);

    const second = await pool.acquire(key, serverOptions());

    expect(second).not.toBe(first);
    expect(seam.transports.length).toBe(2);
    await pool.disposeAll();
  });

  test("three crashes within five minutes stop retry with actionable error", async () => {
    const seam = installMockClientSeam();
    const pool = new LspClientPool({ crashThreshold: 3, crashWindowMs: 300_000 });
    const key = poolKey("/workspace", "typescript");

    for (let i = 0; i < 3; i += 1) {
      await pool.acquire(key, serverOptions());
      seam.transports[i].crash(1);
      await Promise.resolve();
    }

    try {
      await pool.acquire(key, serverOptions());
      throw new Error("Expected acquire to fail after crash loop");
    } catch (error) {
      expect(error).toBeInstanceOf(LspError);
      expect((error as Error).message).toContain("crashed 3 times");
      expect((error as Error).message).toContain("inspect its command");
    }
    expect(seam.transports.length).toBe(3);
  });

  test("failed concurrent acquire uses try/finally cleanup to prevent ref leaks", async () => {
    installMockClientSeam({ initializeError: new Error("initialize failed"), initializeDelayMs: 5 });
    const pool = new LspClientPool();
    const key = poolKey("/workspace", "typescript");

    const results = await Promise.allSettled([
      pool.acquire(key, serverOptions()),
      pool.acquire(key, serverOptions()),
      pool.acquire(key, serverOptions()),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(pool.getRefCountForTest(key)).toBe(0);
    expect(pool.hasEntryForTest(key)).toBe(false);
  });

  test("binary resolution failure clears entry and allows retry", async () => {
    installMockClientSeam();
    let attempt = 0;
    setInstallerProcessRunnerForTest(createSpawnFromExec(async () => {
      attempt += 1;
      if (attempt === 1) return { stdout: "", stderr: "missing", exitCode: 1 };
      return { stdout: "/fake/bin/typescript-language-server\n", stderr: "", exitCode: 0 };
    }));
    const pool = new LspClientPool();
    const key = poolKey("/workspace", "typescript");

    try {
      await pool.acquire(key, serverOptions());
      throw new Error("Expected acquire to fail when binary resolution fails");
    } catch (error) {
      expect(error).toBeInstanceOf(LspInstallerError);
    }

    expect(pool.getRefCountForTest(key)).toBe(0);
    expect(pool.hasEntryForTest(key)).toBe(false);
    await pool.acquire(key, serverOptions());
    expect(pool.hasEntryForTest(key)).toBe(true);
    pool.release(key);
    await pool.disposeAll();
  });

  test("disposeAll shuts down all active clients and clears timers", async () => {
    const seam = installMockClientSeam();
    const timers = new FakeTimers();
    setTimerFnsForTest(timers.fns);
    const pool = new LspClientPool({ idleTimeoutMs: 50 });
    const keyA = poolKey("/workspace", "typescript");
    const keyB = poolKey("/workspace", "rust");

    await pool.acquire(keyA, serverOptions());
    await pool.acquire(keyB, serverOptions());
    pool.release(keyA);

    await pool.disposeAll();

    expect(pool.hasEntryForTest(keyA)).toBe(false);
    expect(pool.hasEntryForTest(keyB)).toBe(false);
    expect(seam.clients.map((client) => client.shutdownCount)).toEqual([1, 1]);
    expect(timers.pendingCount).toBe(0);
  });

  test("setLspClientPoolForTest mock injection works", () => {
    const injected = new LspClientPool({ idleTimeoutMs: 1 });

    setLspClientPoolForTest(injected);

    expect(getLspClientPool()).toBe(injected);
  });
});

function poolKey(workspaceRoot: string, serverId: string): PoolKey {
  return { workspaceRoot, serverId };
}

function serverOptions(): StdioLspTransportOptions {
  return { command: "mock-lsp", cwd: import.meta.dir };
}

interface CallRecord {
  command: string[];
}

function installMockClientSeam(options: { initializeDelayMs?: number; initializeError?: Error } = {}) {
  const transports: MockTransport[] = [];
  const transportOptions: StdioLspTransportOptions[] = [];
  const clients: MockClient[] = [];

  setInstallerProcessRunnerForTest(createSpawnFromExec(async (command) => {
    if (command[0] === "which") return { stdout: `/fake/bin/${command[1]}\n`, stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  }));

  setLspTransportForTest((transportOption) => {
    transportOptions.push(transportOption);
    const transport = new MockTransport();
    transports.push(transport);
    return transport;
  });

  setLspClientForTest(({ transport, workspaceRoot }) => {
    const client = new MockClient({ transport, workspaceRoot, ...options });
    clients.push(client);
    return client as unknown as LspClient;
  });

  return { transports, transportOptions, clients };
}

function createSpawnFromExec(exec: ExecCommand): Parameters<typeof setInstallerProcessRunnerForTest>[0] {
  return (argv) => {
    const stdout = new TransformStream<Uint8Array>();
    const stderr = new TransformStream<Uint8Array>();
    let exitCode: number | null = null;
    const exited = exec([...argv]).then(async (result) => {
      exitCode = result.exitCode;
      await writeText(stdout.writable, result.stdout);
      await writeText(stderr.writable, result.stderr);
      return result.exitCode;
    });

    return {
      stdout: stdout.readable,
      stderr: stderr.readable,
      exited,
      get exitCode() {
        return exitCode;
      },
      signalCode: null,
      kill: () => {},
    };
  };
}

async function writeText(stream: WritableStream<Uint8Array>, text: string): Promise<void> {
  const writer = stream.getWriter();
  try {
    if (text) await writer.write(new TextEncoder().encode(text));
  } finally {
    await writer.close();
    writer.releaseLock();
  }
}

class MockClient {
  initializeCount = 0;
  shutdownCount = 0;
  initializeOptions: unknown;

  constructor(private readonly options: {
    transport: LspTransport;
    workspaceRoot: string;
    initializeDelayMs?: number;
    initializeError?: Error;
  }) {}

  async initialize(workspaceRoot = this.options.workspaceRoot, options?: unknown): Promise<Record<string, unknown>> {
    this.initializeCount += 1;
    this.initializeOptions = options;
    await this.options.transport.connect({ rootUri: workspaceRoot });
    if (this.options.initializeDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.initializeDelayMs));
    }
    if (this.options.initializeError) throw this.options.initializeError;
    return {};
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    await this.options.transport.dispose();
  }
}

class MockTransport implements LspTransport {
  private exitResolve!: (code: number) => void;
  readonly exited: Promise<number>;
  connectCount = 0;
  disposed = false;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  async connect(): Promise<unknown> {
    this.connectCount += 1;
    return { capabilities: {} };
  }

  async sendRequest(): Promise<unknown> {
    return null;
  }

  sendNotification(): void {}

  onNotification(): Disposable {
    return { dispose() {} };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.exitResolve(0);
  }

  crash(code: number): void {
    this.exitResolve(code);
  }
}

class FakeTimers {
  private nextId = 1;
  private readonly timers = new Map<number, () => void>();

  readonly fns: TimerFns = {
    setTimeout: (handler) => {
      const id = this.nextId;
      this.nextId += 1;
      this.timers.set(id, handler);
      return id as unknown as Timer;
    },
    clearTimeout: (timer) => {
      this.timers.delete(timer as unknown as number);
    },
  };

  get pendingCount(): number {
    return this.timers.size;
  }

  async runNext(): Promise<void> {
    const [id, handler] = this.timers.entries().next().value as [number, () => void];
    this.timers.delete(id);
    handler();
    await Promise.resolve();
  }
}
