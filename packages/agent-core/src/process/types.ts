export type ProcessRunnerStdin =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | null;

export interface ProcessRunnerInput {
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: ProcessRunnerStdin;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
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
}

export interface ProcessRunnerErrorSnapshot {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: string;
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
