import { DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST, DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST_NOTE } from "./allowlist";
import type {
  ProcessRunnerAbortResult,
  ProcessRunnerInput,
  ProcessRunnerNonZeroResult,
  ProcessRunnerResult,
  ProcessRunnerSignalResult,
  ProcessRunnerSpawnFailureResult,
  ProcessRunnerSuccessResult,
  ProcessRunnerTimeoutResult,
} from "./types";

export type ProcessRunnerResultKind = ProcessRunnerResult["kind"];

export const PROCESS_RUNNER_RESULT_KINDS = [
  "success",
  "nonzero",
  "timeout",
  "aborted",
  "signal",
  "spawn-failure",
] as const satisfies readonly ProcessRunnerResultKind[];

export interface ProcessRunnerContractDescriptor {
  readonly name: "ProcessRunner";
  readonly input: {
    readonly argv: "readonly tuple where argv[0] is the executable and the rest are arguments";
    readonly cwd: "optional working directory";
    readonly env: "optional environment overrides with undefined values omitted by implementation";
    readonly stdin: "optional stdin payload passed to the child process";
    readonly timeoutMs: "optional wall-clock timeout in milliseconds";
    readonly maxOutputBytes: "optional combined stdout/stderr capture budget in bytes";
    readonly signal: "optional AbortSignal that cancels the run";
  };
  readonly semantics: {
    readonly success: "Process exited with code 0.";
    readonly nonzero: "Process exited normally with a non-zero exit code.";
    readonly timeout: "Process was killed because timeoutMs elapsed before it finished.";
    readonly aborted: "Process was cancelled because the caller AbortSignal fired or the run was otherwise aborted.";
    readonly signal: "Process terminated because it received a signal.";
    readonly spawnFailure: "Process could not be spawned or started.";
  };
  readonly output: {
    readonly stdout: "UTF-8 decoded stdout captured from the process";
    readonly stderr: "UTF-8 decoded stderr captured from the process";
    readonly combined: "best-effort user-facing output assembled from stdout and stderr";
    readonly stdoutTruncated: "true when stdout was clipped by maxOutputBytes";
    readonly stderrTruncated: "true when stderr was clipped by maxOutputBytes";
    readonly combinedTruncated: "true when the combined output was clipped by maxOutputBytes";
  };
  readonly resultKinds: readonly ProcessRunnerResultKind[];
  readonly migrationAllowlist: readonly string[];
  readonly migrationAllowlistNote: string;
}

export const PROCESS_RUNNER_CONTRACT: ProcessRunnerContractDescriptor = {
  name: "ProcessRunner",
  input: {
    argv: "readonly tuple where argv[0] is the executable and the rest are arguments",
    cwd: "optional working directory",
    env: "optional environment overrides with undefined values omitted by implementation",
    stdin: "optional stdin payload passed to the child process",
    timeoutMs: "optional wall-clock timeout in milliseconds",
    maxOutputBytes: "optional combined stdout/stderr capture budget in bytes",
    signal: "optional AbortSignal that cancels the run",
  },
  semantics: {
    success: "Process exited with code 0.",
    nonzero: "Process exited normally with a non-zero exit code.",
    timeout: "Process was killed because timeoutMs elapsed before it finished.",
    aborted: "Process was cancelled because the caller AbortSignal fired or the run was otherwise aborted.",
    signal: "Process terminated because it received a signal.",
    spawnFailure: "Process could not be spawned or started.",
  },
  output: {
    stdout: "UTF-8 decoded stdout captured from the process",
    stderr: "UTF-8 decoded stderr captured from the process",
    combined: "best-effort user-facing output assembled from stdout and stderr",
    stdoutTruncated: "true when stdout was clipped by maxOutputBytes",
    stderrTruncated: "true when stderr was clipped by maxOutputBytes",
    combinedTruncated: "true when the combined output was clipped by maxOutputBytes",
  },
  resultKinds: PROCESS_RUNNER_RESULT_KINDS,
  migrationAllowlist: DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST,
  migrationAllowlistNote: DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST_NOTE,
};

export function createProcessRunnerContract(): ProcessRunnerContractDescriptor {
  return PROCESS_RUNNER_CONTRACT;
}

export type {
  ProcessRunnerAbortResult,
  ProcessRunnerInput,
  ProcessRunnerNonZeroResult,
  ProcessRunnerResult,
  ProcessRunnerSignalResult,
  ProcessRunnerSpawnFailureResult,
  ProcessRunnerSuccessResult,
  ProcessRunnerTimeoutResult,
};
