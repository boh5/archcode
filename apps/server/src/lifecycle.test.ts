import { describe, expect, mock, test } from "bun:test";
import { createInMemoryLogger, type AgentRuntime } from "@archcode/agent-core";
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

function makeRuntime(shutdown = mock(async () => undefined)): AgentRuntime {
  return {
    shutdown,
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

  test("shutdown pushes SSE shutdown, delegates to Runtime, stops, then exits", async () => {
    const order: string[] = [];
    const runtime = makeRuntime(mock(async () => {
      order.push("runtime-shutdown");
    }));
    const globalEvents: unknown[] = [];
    const unsubscribeGlobalEvents = globalEventBus.subscribe((event) => globalEvents.push(event));
    const server = { stop: mock(() => order.push("stop")) };
    const { handlers, processRef } = createProcess();
    processRef.exit = mock((code?: number): never => {
      order.push(`exit:${code}`);
      throw new ExitError(code);
    });

    const { logger, entries } = createInMemoryLogger();
    const handle = setupGracefulShutdown(server, runtime, { process: processRef, logger });
    expect(handlers.has("SIGTERM")).toBe(true);
    await expectExitCode(handle.shutdown("SIGTERM"), 0);
    unsubscribeGlobalEvents();

    expect(runtime.notifyRuntimeShutdown).toHaveBeenCalledWith("server_shutdown");
    expect(runtime.shutdown).toHaveBeenCalled();
    expect(globalEvents).toContainEqual({ type: "shutdown", reason: "server_shutdown" });
    expect(order).toEqual(["runtime-shutdown", "stop", "exit:0"]);
    expect(entries).toContainEqual(expect.objectContaining({
      level: "info",
      event: "server.shutdown.started",
    }));
  });

  test("shutdown exits with code 1 when running jobs exceed timeout", async () => {
    const server = { stop: mock(() => undefined) };
    const runtime = makeRuntime(mock(async () => {
      await new Promise(() => undefined);
    }));
    const { handlers, processRef } = createProcess();
    const { logger, entries } = createInMemoryLogger();

    const handle = setupGracefulShutdown(server, runtime, {
      process: processRef,
      timeoutMs: 1,
      logger,
    });
    expect(handlers.has("SIGINT")).toBe(true);

    await expectExitCode(handle.shutdown("SIGINT"), 1);
    expect(entries).toContainEqual(expect.objectContaining({
      level: "error",
      event: "server.shutdown.timeout",
      meta: { timeoutMs: 1 },
    }));
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
