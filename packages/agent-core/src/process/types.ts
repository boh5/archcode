export type ProcessRunnerStdin =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | null;

export type ProcessOutputStream = "stdout" | "stderr";

/**
 * Optional streaming destination for process output. ProcessRunner owns pipe
 * draining and permanently stops calling the sink after its first failure or
 * one-second write deadline. A sink must not retain the supplied Uint8Array.
 */
export interface ProcessOutputSink {
  write(stream: ProcessOutputStream, chunk: Uint8Array): void | Promise<void>;
  /** Optional non-blocking observation after write delivery has permanently failed. */
  discard?(stream: ProcessOutputStream, chunk: Uint8Array): void | Promise<void>;
}

export interface ProcessRunnerInput {
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: ProcessRunnerStdin;
  readonly timeoutMs?: number;
  /** Maximum retained head-tail bytes per stdout/stderr stream. */
  readonly maxOutputBytes?: number;
  /** Optional raw-byte stream destination; it never controls pipe draining. */
  readonly outputSink?: ProcessOutputSink;
  readonly signal?: AbortSignal;
}

export interface ProcessRunnerOutputCapture {
  readonly stdout: string;
  readonly stderr: string;
  readonly combined: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly combinedTruncated: boolean;
  readonly maxOutputBytes?: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly sinkStatus: "unused" | "complete" | "discarded";
}

export interface ProcessRunnerErrorSnapshot {
  readonly name: string;
  readonly message: string;
}

export interface ProcessRunnerBaseResult {
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly output: ProcessRunnerOutputCapture;
}

export interface ProcessRunnerSuccessResult extends ProcessRunnerBaseResult {
  readonly kind: "success";
  readonly exitCode: 0;
}

export interface ProcessRunnerNonZeroResult extends ProcessRunnerBaseResult {
  readonly kind: "nonzero";
  readonly exitCode: number;
}

export interface ProcessRunnerTimeoutResult extends ProcessRunnerBaseResult {
  readonly kind: "timeout";
  readonly timeoutMs: number;
  readonly exitCode?: number | null;
}

export interface ProcessRunnerAbortResult extends ProcessRunnerBaseResult {
  readonly kind: "aborted";
  readonly timeoutMs?: number;
  readonly exitCode?: number | null;
  readonly reason?: string;
}

export interface ProcessRunnerSignalResult extends ProcessRunnerBaseResult {
  readonly kind: "signal";
  readonly exitCode: number | null;
  readonly signal: number | string;
}

export interface ProcessRunnerSpawnFailureResult {
  readonly kind: "spawn-failure";
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly error: ProcessRunnerErrorSnapshot;
}

export type ProcessRunnerResult =
  | ProcessRunnerSuccessResult
  | ProcessRunnerNonZeroResult
  | ProcessRunnerTimeoutResult
  | ProcessRunnerAbortResult
  | ProcessRunnerSignalResult
  | ProcessRunnerSpawnFailureResult;

export interface ProcessRunner {
  run(input: ProcessRunnerInput): Promise<ProcessRunnerResult>;
}

export class ProcessRunnerError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ProcessRunnerError";
  }
}

export class ProcessRunnerSpawnFailureError extends ProcessRunnerError {
  constructor(
    public readonly argv: readonly [string, ...string[]],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = "ProcessRunnerSpawnFailureError";
  }
}
