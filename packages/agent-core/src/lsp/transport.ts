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
  captureStderr?: boolean;
  stderrBufferLimit?: number;
}

export type LspTransportFactory = (options: StdioLspTransportOptions) => LspTransport;

export const DEFAULT_LSP_TRANSPORT_TIMEOUTS: LspTransportTimeouts = {
  initializeMs: 30_000,
  requestMs: 15_000,
  shutdownMs: 5_000,
};

const EXIT_WAIT_MS = 2_000;
const DEFAULT_STDERR_BUFFER_LIMIT = 16_384;
/** JSON-RPC payload budget, enforced before vscode-jsonrpc can parse a frame. */
export const MAX_LSP_TRANSPORT_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_LSP_TRANSPORT_HEADER_BYTES = 16 * 1024;
const HEADER_SEPARATOR = new Uint8Array([13, 10, 13, 10]);
const CONTENT_LENGTH_HEADER = /^content-length:\s*(\d+)$/i;

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
  const emitCompleteFrames = createFrameEmitter();
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const closeListeners = new Set<() => void>();
  const errorListeners = new Set<(error: unknown) => void>();
  const endListeners = new Set<() => void>();
  let started = false;
  let stopped = false;

  const fail = (error: unknown): void => {
    if (stopped) return;
    stopped = true;
    const safeError = isFrameBoundaryError(error)
      ? error
      : new Error("LSP transport stream failed");
    streamLogger.debug("lsp.transport.stream.error", {
      context: { code: "LSP_TRANSPORT_STREAM_ERROR" },
    });
    for (const listener of errorListeners) listener(safeError);
    reader.cancel().catch(() => undefined);
  };

  const pump = async (): Promise<void> => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) {
          stopped = true;
          for (const listener of endListeners) listener();
          for (const listener of closeListeners) listener();
          return;
        }
        if (value) {
          emitCompleteFrames(value, (frame) => {
            for (const listener of dataListeners) listener(frame);
          });
        }
      }
    } catch (error) {
      fail(error);
    }
  };

  return {
    onData(listener: (data: Uint8Array) => void): Disposable {
      dataListeners.add(listener);
      if (!started) {
        started = true;
        void pump();
      }

      return {
        dispose: () => {
          dataListeners.delete(listener);
          if (dataListeners.size === 0 && !stopped) {
            stopped = true;
            reader.cancel().catch(() => undefined);
          }
        },
      };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    onError(listener) {
      errorListeners.add(listener);
      return { dispose: () => errorListeners.delete(listener) };
    },
    onEnd(listener) {
      endListeners.add(listener);
      return { dispose: () => endListeners.delete(listener) };
    },
  };
}

function createFrameEmitter(): (chunk: Uint8Array, listener: (data: Uint8Array) => void) => void {
  const header = new Uint8Array(MAX_LSP_TRANSPORT_HEADER_BYTES);
  let headerLength = 0;
  let frame: Uint8Array | undefined;
  let frameOffset = 0;

  return (chunk, listener) => {
    let chunkOffset = 0;
    while (chunkOffset < chunk.byteLength) {
      if (frame !== undefined) {
        const count = Math.min(frame.byteLength - frameOffset, chunk.byteLength - chunkOffset);
        frame.set(chunk.subarray(chunkOffset, chunkOffset + count), frameOffset);
        frameOffset += count;
        chunkOffset += count;
        if (frameOffset === frame.byteLength) {
          listener(frame);
          frame = undefined;
          frameOffset = 0;
        }
        continue;
      }

      while (chunkOffset < chunk.byteLength && frame === undefined) {
        if (headerLength === header.byteLength) {
          throw new Error("LSP transport header exceeded 16 KiB");
        }
        header[headerLength++] = chunk[chunkOffset++]!;
        if (!endsWithHeaderSeparator(header, headerLength)) continue;

        const contentLength = parseContentLength(
          header.subarray(0, headerLength - HEADER_SEPARATOR.byteLength),
        );
        if (contentLength === undefined) {
          throw new Error("LSP transport frame has no valid Content-Length");
        }
        if (contentLength > MAX_LSP_TRANSPORT_FRAME_BYTES) {
          throw new Error("LSP transport frame exceeded 8 MiB");
        }

        frame = new Uint8Array(headerLength + contentLength);
        frame.set(header.subarray(0, headerLength));
        frameOffset = headerLength;
        headerLength = 0;
        if (contentLength === 0) {
          listener(frame);
          frame = undefined;
          frameOffset = 0;
        }
      }
    }
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBufferLike> {
  if (left.byteLength === 0) return right;
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function endsWithHeaderSeparator(source: Uint8Array, length: number): boolean {
  if (length < HEADER_SEPARATOR.byteLength) return false;
  for (let offset = 0; offset < HEADER_SEPARATOR.byteLength; offset += 1) {
    if (source[length - HEADER_SEPARATOR.byteLength + offset] !== HEADER_SEPARATOR[offset]) {
      return false;
    }
  }
  return true;
}

function isFrameBoundaryError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("LSP transport ");
}

function parseContentLength(headerBytes: Uint8Array): number | undefined {
  const headers = new TextDecoder("ascii").decode(headerBytes).split("\r\n");
  for (const header of headers) {
    const match = CONTENT_LENGTH_HEADER.exec(header.trim());
    if (match) return Number.parseInt(match[1], 10);
  }
  return undefined;
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
  private stderrReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private stderrCapture: Promise<void> | undefined;
  private stderrBuffer = "";

  constructor(private readonly options: StdioLspTransportOptions) {
    this.timeouts = { ...DEFAULT_LSP_TRANSPORT_TIMEOUTS, ...options.timeouts };
    this.#logger = (options.logger ?? silentLogger).child({ module: "lsp.transport" });
  }

  get exited(): Promise<number> | undefined {
    return this.proc?.exited ?? this.exitPromise;
  }

  get stderrSnapshot(): string {
    return this.stderrBuffer;
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
      stderr: this.options.captureStderr ? "pipe" : "inherit",
    });
    this.exitPromise = this.proc.exited;
    this.startStderrCapture(this.proc);

    const reader = new ReadableStreamMessageReader(adaptReader(this.proc.stdout as ReadableStream<Uint8Array>, { logger: this.#logger }));
    const writer = new WriteableStreamMessageWriter(adaptWriter(this.proc.stdin as { write(chunk: Uint8Array): void; end(): void }));
    this.connection = createMessageConnection(reader, writer);
    this.connection.listen();

    let result: unknown;
    try {
      result = await withTimeout(
        this.connection.sendRequest("initialize", params),
        this.timeouts.initializeMs,
        "initialize",
      );
    } catch (error) {
      await this.dispose();
      this.#logger.error("lsp.transport.initialize.failed", {
        context: { code: "LSP_INITIALIZE_FAILED", stderrCaptured: this.stderrBuffer.length > 0 },
      });
      throw error;
    }
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
    await this.stopStderrCapture();
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

  private startStderrCapture(proc: BunSubprocess): void {
    if (!this.options.captureStderr) return;
    const stream = proc.stderr;
    if (!(stream instanceof ReadableStream)) return;

    const decoder = new TextDecoder();
    const limit = this.options.stderrBufferLimit ?? DEFAULT_STDERR_BUFFER_LIMIT;
    const reader = stream.getReader();
    this.stderrReader = reader;
    const append = (text: string): void => {
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > limit) {
        this.stderrBuffer = this.stderrBuffer.slice(-limit);
      }
    };

    this.stderrCapture = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            append(decoder.decode());
            return;
          }
          if (value) {
            append(decoder.decode(value, { stream: true }));
          }
        }
      } catch {
        this.#logger.debug("lsp.transport.stderr.capture.failed", {
          context: { code: "LSP_STDERR_CAPTURE_FAILED" },
        });
      }
    })();
  }

  private async stopStderrCapture(): Promise<void> {
    const reader = this.stderrReader;
    const capture = this.stderrCapture;
    this.stderrReader = undefined;
    this.stderrCapture = undefined;
    if (!reader || !capture) return;
    try {
      await capture;
    } catch {
      // Stderr capture is best-effort and must not block transport disposal.
    }
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
      context: { pid: proc.pid, code: "LSP_PROCESS_KILL_FAILED" },
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
