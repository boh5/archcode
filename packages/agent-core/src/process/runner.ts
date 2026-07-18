import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import type {
  ProcessRunner,
  ProcessRunnerErrorSnapshot,
  ProcessRunnerInput,
  ProcessOutputSink,
  ProcessOutputStream,
  ProcessRunnerOutputCapture,
  ProcessRunnerResult,
} from "./types";

const MAX_EAGAIN_RETRIES = 3;
const EAGAIN_RETRY_BASE_DELAY_MS = 10;
const DEFAULT_ABORT_REASON = "aborted";
export const DEFAULT_RETAINED_OUTPUT_BYTES_PER_STREAM = 1024 * 1024;
export const PROCESS_SINK_CHUNK_BYTES = 64 * 1024;
export const PROCESS_SINK_WRITE_TIMEOUT_MS = 1000;

let _logger: Logger = silentLogger;

/** Configure the module-level logger for the default ProcessRunner. */
export function configureDefaultProcessRunnerLogger(logger: Logger): void {
  _logger = logger;
}

type SpawnResult = {
  readonly stdout?: ReadableStream<Uint8Array> | null;
  readonly stderr?: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly exitCode?: number | null;
  readonly signalCode?: number | string | null;
  kill(signal?: number | string): void;
};

type SpawnOptions = {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: ProcessRunnerInput["stdin"] | "ignore";
  readonly stdout: "pipe";
  readonly stderr: "pipe";
};

type SpawnCommand = (
  argv: readonly [string, ...string[]],
  options: SpawnOptions,
) => SpawnResult;

let spawnForTest: SpawnCommand | undefined;

export function setProcessRunnerSpawnForTest(fn: SpawnCommand | undefined): void {
  spawnForTest = fn;
}

export function setProcessRunnerForTest(fn: SpawnCommand | undefined): void {
  spawnForTest = fn;
}

export function createProcessRunner(): ProcessRunner {
  return new BunProcessRunner();
}

class BunProcessRunner implements ProcessRunner {
  async run(input: ProcessRunnerInput): Promise<ProcessRunnerResult> {
    const startedAt = Date.now();
    let proc: SpawnResult;

    try {
      proc = await spawnWithEagainRetry(input);
    } catch (error) {
      _logger.error("process.spawn.failed", {
        module: "process.runner",
        context: { command: input.argv[0], code: "PROCESS_SPAWN_FAILED", errorName: stableErrorName(error) },
      });
      return {
        kind: "spawn-failure",
        argv: input.argv,
        cwd: input.cwd,
        error: snapshotError(error),
      };
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let aborted = input.signal?.aborted ?? false;
    const abortReason = () => formatAbortReason(input.signal?.reason);

    const killForAbort = () => {
      aborted = true;
      safeKill(proc);
    };

    if (input.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        safeKill(proc);
      }, input.timeoutMs);
    }

    if (input.signal) {
      if (input.signal.aborted) {
        killForAbort();
      } else {
        input.signal.addEventListener("abort", killForAbort, { once: true });
      }
    }

    try {
      const retainedBytes = normalizeRetainedBytes(input.maxOutputBytes);
      const sink = new SinkController(input.outputSink);
      const [stdout, stderr, exitCode] = await Promise.all([
        drainOutput(proc.stdout, "stdout", retainedBytes, sink),
        drainOutput(proc.stderr, "stderr", retainedBytes, sink),
        proc.exited,
      ]);
      const finishedAt = Date.now();
      const output = buildOutputCapture(stdout, stderr, retainedBytes, input.maxOutputBytes, sink.status);
      const base = {
        argv: input.argv,
        cwd: input.cwd,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        output,
      };

      if (timedOut) {
        _logger.warn("process.timeout", {
          module: "process.runner",
          context: { command: input.argv[0], timeoutMs: input.timeoutMs },
        });
        return { ...base, kind: "timeout", timeoutMs: input.timeoutMs!, exitCode };
      }

      if (aborted) {
        _logger.debug("process.aborted", {
          module: "process.runner",
          context: { command: input.argv[0], reason: abortReason() },
        });
        return { ...base, kind: "aborted", timeoutMs: input.timeoutMs, exitCode, reason: abortReason() };
      }

      const signal = proc.signalCode;
      if (signal !== undefined && signal !== null) {
        _logger.warn("process.killed", {
          module: "process.runner",
          context: { command: input.argv[0], signal: String(signal) },
        });
        return { ...base, kind: "signal", exitCode, signal };
      }

      if (exitCode === 0) return { ...base, kind: "success", exitCode };

      return { ...base, kind: "nonzero", exitCode };
    } finally {
      if (timeout) clearTimeout(timeout);
      input.signal?.removeEventListener("abort", killForAbort);
    }
  }
}

async function spawnWithEagainRetry(input: ProcessRunnerInput): Promise<SpawnResult> {
  for (let attempt = 0; attempt <= MAX_EAGAIN_RETRIES; attempt++) {
    try {
      return spawnProcess(input);
    } catch (error) {
      if (!isEagainError(error) || attempt === MAX_EAGAIN_RETRIES) throw error;
      await sleep(EAGAIN_RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }

  throw new Error("unreachable");
}

function spawnProcess(input: ProcessRunnerInput): SpawnResult {
  const options: SpawnOptions = {
    cwd: input.cwd,
    env: sanitizeEnv(input.env),
    stdin: input.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  };

  const spawn = spawnForTest ?? ((argv, opts) => Bun.spawn([...argv], opts as Parameters<typeof Bun.spawn>[1]) as SpawnResult);
  return spawn(input.argv, options);
}

function sanitizeEnv(env: ProcessRunnerInput["env"]): Record<string, string> | undefined {
  if (!env) return undefined;

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) sanitized[key] = value;
  }

  return sanitized;
}

interface DrainedOutput {
  readonly bytes: Uint8Array;
  readonly observedBytes: number;
  readonly truncated: boolean;
}

async function drainOutput(
  stream: ReadableStream<Uint8Array> | null | undefined,
  streamName: ProcessOutputStream,
  retainedBytes: number,
  sink: SinkController,
): Promise<DrainedOutput> {
  if (!stream) return { bytes: new Uint8Array(), observedBytes: 0, truncated: false };

  const reader = stream.getReader();
  const ring = new HeadTailByteRing(retainedBytes);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      ring.push(value);
      for (let offset = 0; offset < value.byteLength; offset += PROCESS_SINK_CHUNK_BYTES) {
        await sink.write(streamName, value.subarray(offset, Math.min(value.byteLength, offset + PROCESS_SINK_CHUNK_BYTES)));
      }
    }
  } finally {
    reader.releaseLock();
  }

  return ring.finish();
}

function buildOutputCapture(
  stdout: DrainedOutput,
  stderr: DrainedOutput,
  retainedBytes: number,
  requestedMaxOutputBytes: number | undefined,
  sinkStatus: ProcessRunnerOutputCapture["sinkStatus"],
): ProcessRunnerOutputCapture {
  const stdoutText = new TextDecoder().decode(stdout.bytes);
  const stderrText = new TextDecoder().decode(stderr.bytes);
  const combinedSource = `${stdoutText}${stderrText}`;
  const combined = capStringByBytes(combinedSource, retainedBytes);

  return {
    stdout: stdoutText,
    stderr: stderrText,
    combined: combined.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    combinedTruncated: stdout.truncated || stderr.truncated || combined.truncated,
    ...(requestedMaxOutputBytes === undefined ? {} : { maxOutputBytes: requestedMaxOutputBytes }),
    stdoutBytes: stdout.observedBytes,
    stderrBytes: stderr.observedBytes,
    sinkStatus,
  };
}

function capStringByBytes(text: string, maxBytes: number | undefined): { text: string; truncated: boolean } {
  if (maxBytes === undefined) return { text, truncated: false };

  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return { text, truncated: false };

  return { text: new TextDecoder().decode(encoded.slice(0, maxBytes)), truncated: true };
}

function normalizeRetainedBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETAINED_OUTPUT_BYTES_PER_STREAM;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("ProcessRunner maxOutputBytes must be a non-negative safe integer");
  }
  return Math.min(value, DEFAULT_RETAINED_OUTPUT_BYTES_PER_STREAM);
}

class HeadTailByteRing {
  readonly #headCapacity: number;
  readonly #tailCapacity: number;
  readonly #head: Uint8Array;
  readonly #tail: Uint8Array;
  #headBytes = 0;
  #tailBytes = 0;
  #tailStart = 0;
  #observedBytes = 0;

  constructor(capacity: number) {
    this.#headCapacity = Math.ceil(capacity / 2);
    this.#tailCapacity = capacity - this.#headCapacity;
    this.#head = new Uint8Array(this.#headCapacity);
    this.#tail = new Uint8Array(this.#tailCapacity);
  }

  push(chunk: Uint8Array): void {
    this.#observedBytes += chunk.byteLength;
    let offset = 0;
    if (this.#headBytes < this.#headCapacity) {
      const count = Math.min(chunk.byteLength, this.#headCapacity - this.#headBytes);
      if (count > 0) {
        this.#head.set(chunk.subarray(0, count), this.#headBytes);
        this.#headBytes += count;
        offset = count;
      }
    }
    if (offset < chunk.byteLength && this.#tailCapacity > 0) {
      this.#pushTail(chunk.subarray(offset));
    }
  }

  finish(): DrainedOutput {
    const bytes = new Uint8Array(this.#headBytes + this.#tailBytes);
    bytes.set(this.#head.subarray(0, this.#headBytes));
    if (this.#tailBytes < this.#tailCapacity) {
      bytes.set(this.#tail.subarray(0, this.#tailBytes), this.#headBytes);
    } else if (this.#tailBytes > 0) {
      const first = this.#tail.subarray(this.#tailStart);
      bytes.set(first, this.#headBytes);
      bytes.set(this.#tail.subarray(0, this.#tailStart), this.#headBytes + first.byteLength);
    }
    return {
      bytes,
      observedBytes: this.#observedBytes,
      truncated: this.#observedBytes > bytes.byteLength,
    };
  }

  #pushTail(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.#tailCapacity) {
      this.#tail.set(chunk.subarray(chunk.byteLength - this.#tailCapacity));
      this.#tailBytes = this.#tailCapacity;
      this.#tailStart = 0;
      return;
    }

    const writeAt = (this.#tailStart + this.#tailBytes) % this.#tailCapacity;
    const firstCount = Math.min(chunk.byteLength, this.#tailCapacity - writeAt);
    this.#tail.set(chunk.subarray(0, firstCount), writeAt);
    if (firstCount < chunk.byteLength) this.#tail.set(chunk.subarray(firstCount), 0);

    const overflow = Math.max(0, this.#tailBytes + chunk.byteLength - this.#tailCapacity);
    this.#tailStart = (this.#tailStart + overflow) % this.#tailCapacity;
    this.#tailBytes = Math.min(this.#tailCapacity, this.#tailBytes + chunk.byteLength);
  }
}

class SinkController {
  readonly #sink: ProcessOutputSink | undefined;
  #discarded = false;
  /** stdout/stderr drain concurrently; serialize the shared sink so bounded capture capacity cannot race. */
  #writeTail: Promise<void> = Promise.resolve();

  constructor(sink: ProcessOutputSink | undefined) {
    this.#sink = sink;
  }

  get status(): ProcessRunnerOutputCapture["sinkStatus"] {
    if (this.#sink === undefined) return "unused";
    return this.#discarded ? "discarded" : "complete";
  }

  async write(stream: ProcessOutputStream, chunk: Uint8Array): Promise<void> {
    if (this.#sink === undefined || chunk.byteLength === 0) return;
    if (this.#discarded) {
      try {
        void Promise.resolve(this.#sink.discard?.(stream, chunk)).catch(() => undefined);
      } catch {
        // Observation after failure is best-effort and may never re-enable writes.
      }
      return;
    }
    const write = this.#writeTail.then(async () => {
      if (this.#discarded) return;
      try {
        await withDeadline(Promise.resolve(this.#sink!.write(stream, chunk)), PROCESS_SINK_WRITE_TIMEOUT_MS);
      } catch {
        this.#discarded = true;
      }
    });
    this.#writeTail = write;
    await write;
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Process output sink write timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isEagainError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: unknown }).code === "EAGAIN";
}

function snapshotError(error: unknown): ProcessRunnerErrorSnapshot {
  return { name: stableErrorName(error), message: "Process failed to start" };
}

function stableErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "ProcessSpawnError";
  const name = error.name.trim();
  return name.length > 0 && name.length <= 128 ? name : "ProcessSpawnError";
}

function formatAbortReason(reason: unknown): string | undefined {
  if (reason === undefined) return DEFAULT_ABORT_REASON;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function safeKill(proc: SpawnResult): void {
  try {
    proc.kill();
  } catch {
    // Process may already have exited.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
