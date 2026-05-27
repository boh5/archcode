import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import type {
  ProcessRunner,
  ProcessRunnerErrorSnapshot,
  ProcessRunnerInput,
  ProcessRunnerOutputCapture,
  ProcessRunnerResult,
} from "./types";

const MAX_EAGAIN_RETRIES = 3;
const EAGAIN_RETRY_BASE_DELAY_MS = 10;
const DEFAULT_ABORT_REASON = "aborted";

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
        error,
        context: { command: input.argv[0] },
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
      const budget = { remaining: input.maxOutputBytes ?? Number.POSITIVE_INFINITY };
      const [stdout, stderr, exitCode] = await Promise.all([
        readOutput(proc.stdout, budget),
        readOutput(proc.stderr, budget),
        proc.exited,
      ]);
      const finishedAt = Date.now();
      const output = buildOutputCapture(stdout, stderr, input.maxOutputBytes);
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

async function readOutput(
  stream: ReadableStream<Uint8Array> | null | undefined,
  budget: { remaining: number },
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (budget.remaining <= 0) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      const allowed = Math.min(value.byteLength, budget.remaining);
      chunks.push(allowed === value.byteLength ? value : value.slice(0, allowed));
      budget.remaining -= allowed;
      if (allowed < value.byteLength) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text: new TextDecoder().decode(concatChunks(chunks)), truncated };
}

function buildOutputCapture(
  stdout: { text: string; truncated: boolean },
  stderr: { text: string; truncated: boolean },
  maxOutputBytes: number | undefined,
): ProcessRunnerOutputCapture {
  const combinedSource = `${stdout.text}${stderr.text}`;
  const combined = capStringByBytes(combinedSource, maxOutputBytes);

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    combined: combined.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    combinedTruncated: stdout.truncated || stderr.truncated || combined.truncated,
    maxOutputBytes,
  };
}

function capStringByBytes(text: string, maxBytes: number | undefined): { text: string; truncated: boolean } {
  if (maxBytes === undefined) return { text, truncated: false };

  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return { text, truncated: false };

  return { text: new TextDecoder().decode(encoded.slice(0, maxBytes)), truncated: true };
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isEagainError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: unknown }).code === "EAGAIN";
}

function snapshotError(error: unknown): ProcessRunnerErrorSnapshot {
  if (error instanceof Error) {
    const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: cause === undefined ? undefined : String(cause),
    };
  }

  return { name: "Error", message: String(error) };
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
