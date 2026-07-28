export const SESSION_SNAPSHOT_RECOVERY_RETRY_BASE_MS = 1_000;
export const SESSION_SNAPSHOT_RECOVERY_RETRY_MAX_MS = 15_000;

export interface SessionSnapshotRecoveryState {
  status: "live" | "awaiting";
  generation: number;
}

export interface SessionSnapshotRequestState {
  terminalFailure: boolean;
  fetching: boolean;
}

interface SessionSnapshotRecoveryRetryOptions {
  readRecoveryState: () => SessionSnapshotRecoveryState;
  refetch: () => Promise<unknown> | void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
}

export interface SessionSnapshotRecoveryRetry {
  update: (requestState: SessionSnapshotRequestState) => void;
  dispose: () => void;
}

export function createSessionSnapshotRecoveryRetry(
  options: SessionSnapshotRecoveryRetryOptions,
): SessionSnapshotRecoveryRetry {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let requestState: SessionSnapshotRequestState = {
    terminalFailure: false,
    fetching: false,
  };
  let generation: number | undefined;
  let retryAttempt = 0;
  let timer: unknown;
  let disposed = false;

  const clearTimer = () => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };

  const scheduleCurrentGeneration = () => {
    if (disposed) return;
    const recovery = options.readRecoveryState();
    if (
      !requestState.terminalFailure
      || requestState.fetching
      || recovery.status !== "awaiting"
    ) {
      clearTimer();
      if (recovery.status === "live") {
        generation = undefined;
        retryAttempt = 0;
      }
      return;
    }

    if (generation !== recovery.generation) {
      clearTimer();
      generation = recovery.generation;
      retryAttempt = 0;
    }
    if (timer !== undefined) return;

    const scheduledGeneration = recovery.generation;
    const delayMs = Math.min(
      SESSION_SNAPSHOT_RECOVERY_RETRY_BASE_MS * (2 ** retryAttempt),
      SESSION_SNAPSHOT_RECOVERY_RETRY_MAX_MS,
    );
    let scheduledTimer: unknown;
    scheduledTimer = schedule(() => {
      if (timer !== scheduledTimer) return;
      timer = undefined;
      if (disposed) return;
      const latest = options.readRecoveryState();
      if (
        !requestState.terminalFailure
        || requestState.fetching
        || latest.status !== "awaiting"
        || latest.generation !== scheduledGeneration
      ) {
        return;
      }
      retryAttempt += 1;
      void Promise.resolve(options.refetch()).catch(() => {});
    }, delayMs);
    timer = scheduledTimer;
  };

  return {
    update: (nextRequestState) => {
      requestState = nextRequestState;
      scheduleCurrentGeneration();
    },
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}
