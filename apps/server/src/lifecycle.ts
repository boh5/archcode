import {
  createConsoleLogger,
  type Logger,
} from "@archcode/agent-core";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface LifecycleServer {
  stop(force?: boolean): void;
}

export interface LifecycleTarget {
  shutdown(reason: string): Promise<void>;
}

export interface SignalProcess {
  on(signal: ShutdownSignal, handler: () => void): unknown;
  off?(signal: ShutdownSignal, handler: () => void): unknown;
  removeListener?(signal: ShutdownSignal, handler: () => void): unknown;
  exit(code?: number): never;
}

export interface GracefulShutdownOptions {
  timeoutMs?: number;
  process?: SignalProcess;
  logger?: Logger;
  deadlineScheduler?: ShutdownDeadlineScheduler;
}

export interface ShutdownDeadlineHandle {
  readonly id?: unknown;
}

export interface ShutdownDeadlineScheduler {
  schedule(delayMs: number, callback: () => void): ShutdownDeadlineHandle;
  cancel(handle: ShutdownDeadlineHandle): void;
}

const systemShutdownDeadlineScheduler: ShutdownDeadlineScheduler = {
  schedule(delayMs, callback) {
    const id = setTimeout(callback, delayMs);
    return { id };
  },
  cancel(handle) {
    if (handle.id !== undefined) clearTimeout(handle.id as Timer);
  },
};

export interface GracefulShutdownHandle {
  dispose(): void;
  shutdown(request?: ShutdownRequest): Promise<number>;
}

export interface ShutdownRequest {
  reason: string;
  exitCode: number;
}

export function setupGracefulShutdown(
  server: LifecycleServer,
  target: LifecycleTarget,
  options: GracefulShutdownOptions = {},
): GracefulShutdownHandle {
  const processRef = options.process ?? process;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const logger = options.logger ?? createConsoleLogger({
    level: "info",
    module: "server.lifecycle",
  });
  let shutdownPromise: Promise<number> | undefined;

  const shutdown = async (
    request: ShutdownRequest = {
      reason: "server_shutdown",
      exitCode: 0,
    },
  ): Promise<number> => {
    if (shutdownPromise) return await shutdownPromise;

    shutdownPromise = runShutdown(
      server,
      target,
      timeoutMs,
      logger,
      options.deadlineScheduler ?? systemShutdownDeadlineScheduler,
      request,
    );
    const exitCode = await shutdownPromise;
    processRef.exit(exitCode);
    return exitCode;
  };

  const onSignal = (_signal: ShutdownSignal) => {
    void shutdown();
  };
  const sigintHandler = () => onSignal("SIGINT");
  const sigtermHandler = () => onSignal("SIGTERM");

  processRef.on("SIGINT", sigintHandler);
  processRef.on("SIGTERM", sigtermHandler);

  return {
    dispose(): void {
      removeSignalHandler(processRef, "SIGINT", sigintHandler);
      removeSignalHandler(processRef, "SIGTERM", sigtermHandler);
    },
    shutdown,
  };
}

async function runShutdown(
  server: LifecycleServer,
  target: LifecycleTarget,
  timeoutMs: number,
  logger: Logger,
  deadlineScheduler: ShutdownDeadlineScheduler,
  request: ShutdownRequest,
): Promise<number> {
  logger.info("server.shutdown.started");

  let timeoutHandle: ShutdownDeadlineHandle | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = deadlineScheduler.schedule(timeoutMs, () => resolve("timeout"));
  });
  let result: "completed" | "timeout" | "failed";
  try {
    try {
      result = await Promise.race([
        target.shutdown(request.reason).then(() => "completed" as const),
        timeout,
      ]);
    } catch (error) {
      result = "failed";
      logger.error("server.shutdown.failed", {
        message: "Graceful shutdown failed",
        error,
      });
    }
  } finally {
    if (timeoutHandle !== undefined) deadlineScheduler.cancel(timeoutHandle);
  }
  const exitCode = result === "completed" ? request.exitCode : 1;

  if (result === "timeout") {
    logger.error("server.shutdown.timeout", {
      message: `Graceful shutdown timed out after ${timeoutMs}ms`,
      meta: { timeoutMs },
    });
  }

  server.stop();
  return exitCode;
}

function removeSignalHandler(processRef: SignalProcess, signal: ShutdownSignal, handler: () => void): void {
  if (processRef.off) {
    processRef.off(signal, handler);
    return;
  }

  processRef.removeListener?.(signal, handler);
}
