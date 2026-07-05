import type { AgentRuntime } from "@archcode/agent-core";
import { globalEventBus } from "./events/global-event-bus";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface LifecycleServer {
  stop(force?: boolean): void;
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
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface GracefulShutdownHandle {
  dispose(): void;
  shutdown(signal?: ShutdownSignal): Promise<number>;
}

export function setupGracefulShutdown(
  server: LifecycleServer,
  runtime: AgentRuntime,
  options: GracefulShutdownOptions = {},
): GracefulShutdownHandle {
  const processRef = options.process ?? process;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const log = options.log ?? console.info;
  const error = options.error ?? console.error;
  let shutdownPromise: Promise<number> | undefined;

  const shutdown = async (_signal?: ShutdownSignal): Promise<number> => {
    if (shutdownPromise) return await shutdownPromise;

    shutdownPromise = runShutdown(server, runtime, timeoutMs, log, error);
    const exitCode = await shutdownPromise;
    processRef.exit(exitCode);
    return exitCode;
  };

  const onSignal = (signal: ShutdownSignal) => {
    void shutdown(signal);
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
  runtime: AgentRuntime,
  timeoutMs: number,
  log: (message: string) => void,
  error: (message: string) => void,
): Promise<number> {
  log("Shutting down gracefully...");
  pushShutdownEvents(runtime);

  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([
    Promise.all([runtime.stopLoopSchedulers(), runtime.abortAllSessionExecutions()]).then(() => "completed" as const),
    timeout,
  ]);
  const exitCode = result === "timeout" ? 1 : 0;

  if (result === "timeout") {
    error(`Graceful shutdown timed out after ${timeoutMs}ms`);
  }

  server.stop();
  return exitCode;
}

function pushShutdownEvents(runtime: AgentRuntime): void {
  globalEventBus.emit({ type: "shutdown", reason: "server_shutdown" });
  runtime.notifyRuntimeShutdown("server_shutdown");
}

function removeSignalHandler(processRef: SignalProcess, signal: ShutdownSignal, handler: () => void): void {
  if (processRef.off) {
    processRef.off(signal, handler);
    return;
  }

  processRef.removeListener?.(signal, handler);
}
