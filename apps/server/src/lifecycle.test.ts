import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime } from "@archcode/agent-core";
import { globalEventBus } from "./events/global-event-bus";
import { setupGracefulShutdown, type ShutdownSignal, type SignalProcess } from "./lifecycle";

class ExitError extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined) {
    super(`exit:${code}`);
    this.name = "ExitError";
    this.code = code;
  }
}

function createProcess() {
  const handlers = new Map<ShutdownSignal, () => void>();
  const processRef: SignalProcess = {
    on: mock((signal: ShutdownSignal, handler: () => void) => {
      handlers.set(signal, handler);
    }),
    off: mock((signal: ShutdownSignal) => {
      handlers.delete(signal);
    }),
    exit: mock((code?: number): never => {
      throw new ExitError(code);
    }),
  };

  return { handlers, processRef };
}

function makeRuntime(abortAllSessionExecutions = mock(async () => undefined)): AgentRuntime {
  return {
    abortAllSessionExecutions,
    stopLoopSchedulers: mock(() => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
  } as unknown as AgentRuntime;
}

describe("server lifecycle", () => {
  test("setupGracefulShutdown registers signal handlers", () => {
    const { handlers, processRef } = createProcess();
    const server = { stop: mock(() => undefined) };
    const runtime = makeRuntime();

    const handle = setupGracefulShutdown(server, runtime, { process: processRef });

    expect(processRef.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processRef.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);

    handle.dispose();
    expect(processRef.off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processRef.off).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  test("shutdown pushes SSE shutdown, aborts, waits, stops, then exits", async () => {
    const order: string[] = [];
    const runtime = makeRuntime(mock(async () => {
      order.push("abort");
      order.push("wait");
    }));
    runtime.stopLoopSchedulers = mock(async () => {
      order.push("stop-schedulers");
    });
    const globalEvents: unknown[] = [];
    const unsubscribeGlobalEvents = globalEventBus.subscribe((event) => globalEvents.push(event));
    const server = { stop: mock(() => order.push("stop")) };
    const { handlers, processRef } = createProcess();
    processRef.exit = mock((code?: number): never => {
      order.push(`exit:${code}`);
      throw new ExitError(code);
    });

    const handle = setupGracefulShutdown(server, runtime, { process: processRef, log: () => undefined });
    expect(handlers.has("SIGTERM")).toBe(true);
    await expectExitCode(handle.shutdown("SIGTERM"), 0);
    unsubscribeGlobalEvents();

    expect(runtime.notifyRuntimeShutdown).toHaveBeenCalledWith("server_shutdown");
    expect(runtime.abortAllSessionExecutions).toHaveBeenCalled();
    expect(globalEvents).toContainEqual({ type: "shutdown", reason: "server_shutdown" });
    expect(runtime.stopLoopSchedulers).toHaveBeenCalled();
    expect(order).toEqual(["stop-schedulers", "abort", "wait", "stop", "exit:0"]);
  });

  test("shutdown exits with code 1 when running jobs exceed timeout", async () => {
    const server = { stop: mock(() => undefined) };
    const runtime = makeRuntime(mock(async () => {
      await new Promise(() => undefined);
    }));
    const { handlers, processRef } = createProcess();
    const error = mock((_message: string) => undefined);

    const handle = setupGracefulShutdown(server, runtime, { process: processRef, timeoutMs: 1, log: () => undefined, error });
    expect(handlers.has("SIGINT")).toBe(true);

    await expectExitCode(handle.shutdown("SIGINT"), 1);
    expect(error).toHaveBeenCalledWith("Graceful shutdown timed out after 1ms");
    expect(server.stop).toHaveBeenCalled();
  });
});

async function expectExitCode(promise: Promise<number>, code: number): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toMatchObject({ name: "ExitError", code });
    return;
  }

  throw new Error("Expected shutdown to exit the process");
}
