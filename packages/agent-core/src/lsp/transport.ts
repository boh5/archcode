import type { Disposable } from "vscode-jsonrpc";
import {
  ReadableStreamMessageReader,
  WriteableStreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";

export interface LspTransport {
  connect(params?: unknown): Promise<unknown>;
  sendRequest(method: string, params?: unknown): Promise<unknown>;
  sendNotification(method: string, params?: unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): Disposable;
  dispose(): Promise<void>;
}

export interface RALReadable {
  onData(listener: (data: Uint8Array) => void): Disposable;
  onClose(listener: () => void): Disposable;
  onError(listener: (error: unknown) => void): Disposable;
  onEnd(listener: () => void): Disposable;
}

export interface RALWritable {
  write(data: Uint8Array | string, encoding?: string): Promise<void>;
  end(): void;
  onClose(listener: () => void): Disposable;
  onError(listener: (error: unknown) => void): Disposable;
  onEnd(listener: () => void): Disposable;
}

export interface LspTransportTimeouts {
  initializeMs: number;
  requestMs: number;
  shutdownMs: number;
}

export interface StdioLspTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeouts?: Partial<LspTransportTimeouts>;
  logger?: Logger;
}

export type LspTransportFactory = (options: StdioLspTransportOptions) => LspTransport;

export const DEFAULT_LSP_TRANSPORT_TIMEOUTS: LspTransportTimeouts = {
  initializeMs: 30_000,
  requestMs: 15_000,
  shutdownMs: 5_000,
};

const EXIT_WAIT_MS = 2_000;

type MessageConnection = ReturnType<typeof createMessageConnection>;
type BunSubprocess = ReturnType<typeof Bun.spawn>;

let transportFactoryForTest: LspTransportFactory | undefined;

export function setLspTransportForTest(factory: LspTransportFactory | undefined): void {
  transportFactoryForTest = factory;
}

export function createLspTransport(options: StdioLspTransportOptions): LspTransport {
  return transportFactoryForTest ? transportFactoryForTest(options) : new StdioLspTransport(options);
}

export function adaptReader(stream: ReadableStream<Uint8Array>, options: { logger?: Logger } = {}): RALReadable {
  const reader = stream.getReader();
  const streamLogger = (options.logger ?? silentLogger).child({ module: "lsp.transport" });

  return {
    onData(listener: (data: Uint8Array) => void): Disposable {
      let cancelled = false;
      const pump = () => {
        if (cancelled) return;

        reader.read().then(({ done, value }) => {
          if (cancelled || done) return;
          if (value) listener(value);
          pump();
        }).catch((error) => {
          streamLogger.debug("lsp.transport.stream.error", {
            context: { error: error instanceof Error ? error.message : String(error) },
          });
        });
      };

      pump();

      return {
        dispose: () => {
          cancelled = true;
          reader.cancel().catch(() => undefined);
        },
      };
    },
    onClose: () => ({ dispose: () => {} }),
    onError: () => ({ dispose: () => {} }),
    onEnd: () => ({ dispose: () => {} }),
  };
}

export function adaptWriter(sink: { write(chunk: Uint8Array): void; end(): void }): RALWritable {
  const encoder = new TextEncoder();

  return {
    async write(data: Uint8Array | string): Promise<void> {
      sink.write(typeof data === "string" ? encoder.encode(data) : data);
    },
    end(): void {
      sink.end();
    },
    onClose: () => ({ dispose: () => {} }),
    onError: () => ({ dispose: () => {} }),
    onEnd: () => ({ dispose: () => {} }),
  };
}

export class StdioLspTransport implements LspTransport {
  private readonly timeouts: LspTransportTimeouts;
  #logger: Logger;
  private proc: BunSubprocess | undefined;
  private exitPromise: Promise<number> | undefined;
  private connection: MessageConnection | undefined;
  private disposed = false;
  private initialized = false;

  constructor(private readonly options: StdioLspTransportOptions) {
    this.timeouts = { ...DEFAULT_LSP_TRANSPORT_TIMEOUTS, ...options.timeouts };
    this.#logger = (options.logger ?? silentLogger).child({ module: "lsp.transport" });
  }

  get exited(): Promise<number> | undefined {
    return this.proc?.exited ?? this.exitPromise;
  }

  async connect(params: unknown = defaultInitializeParams()): Promise<unknown> {
    if (this.disposed) throw new Error("LSP transport has been disposed");
    if (this.connection) return this.sendRequest("initialize", params);

    // Keep direct Bun.spawn here: LSP transport owns a long-lived JSON-RPC stdio process,
    // while ProcessRunner is for short-lived commands with captured output.
    this.proc = Bun.spawn([this.options.command, ...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    this.exitPromise = this.proc.exited;

    const reader = new ReadableStreamMessageReader(adaptReader(this.proc.stdout as ReadableStream<Uint8Array>, { logger: this.#logger }));
    const writer = new WriteableStreamMessageWriter(adaptWriter(this.proc.stdin as { write(chunk: Uint8Array): void; end(): void }));
    this.connection = createMessageConnection(reader, writer);
    this.connection.listen();

    const result = await withTimeout(
      this.connection.sendRequest("initialize", params),
      this.timeouts.initializeMs,
      "initialize",
    );
    this.initialized = true;
    return result;
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const connection = this.requireConnection();
    return withTimeout(connection.sendRequest(method, params), this.timeouts.requestMs, method);
  }

  sendNotification(method: string, params?: unknown): void {
    this.requireConnection().sendNotification(method, params);
  }

  onNotification(method: string, handler: (params: unknown) => void): Disposable {
    return this.requireConnection().onNotification(method, handler);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const connection = this.connection;
    const proc = this.proc;

    if (connection && proc && proc.exitCode === null) {
      if (this.initialized) {
        await ignoreErrors(withTimeout(connection.sendRequest("shutdown", null), this.timeouts.shutdownMs, "shutdown"));
      }

      ignoreErrorsSync(() => connection.sendNotification("exit"));
      await this.waitOrEscalate(proc);
    }

    if (connection) {
      ignoreErrorsSync(() => connection.end());
    }

    this.connection = undefined;
    this.proc = undefined;
  }

  private requireConnection(): MessageConnection {
    if (!this.connection) throw new Error("LSP transport is not connected");
    return this.connection;
  }

  private async waitOrEscalate(proc: BunSubprocess): Promise<void> {
    if (await waitForExit(proc, EXIT_WAIT_MS)) return;

    safeKill(proc, "SIGTERM", this.#logger);
    if (await waitForExit(proc, EXIT_WAIT_MS)) return;
    this.#logger.warn("lsp.transport.process.kill.timeout", { context: { pid: proc.pid, signal: "SIGTERM" } });

    safeKill(proc, "SIGKILL", this.#logger);
    this.#logger.error("lsp.transport.process.kill.escalated", { context: { pid: proc.pid, signal: "SIGKILL" } });
    await ignoreErrors(proc.exited);
  }
}

function defaultInitializeParams(): unknown {
  return { processId: null, capabilities: {}, rootUri: null };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: Timer | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`LSP ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForExit(proc: BunSubprocess, timeoutMs: number): Promise<boolean> {
  let timeout: Timer | undefined;
  try {
    await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("process exit wait timed out")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function safeKill(proc: BunSubprocess, signal: "SIGTERM" | "SIGKILL", logger: Logger = silentLogger): void {
  try {
    proc.kill(signal);
  } catch (error) {
    logger.debug("lsp.transport.process.kill.failed", {
      context: { pid: proc.pid, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function ignoreErrors(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Shutdown must be best-effort.
  }
}

function ignoreErrorsSync(fn: () => void): void {
  try {
    fn();
  } catch {
    // Shutdown must be best-effort.
  }
}
