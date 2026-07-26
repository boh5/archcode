import { describe, expect, mock, test } from "bun:test";
import { createInMemoryLogger, silentLogger } from "@archcode/agent-core";
import {
  setupGracefulShutdown,
  type ShutdownDeadlineHandle,
  type ShutdownDeadlineScheduler,
  type ShutdownSignal,
  type SignalProcess,
} from "./lifecycle";

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

function makeTarget(shutdown = mock(async () => undefined)) {
  return { shutdown };
}

function createManualDeadlineScheduler(): ShutdownDeadlineScheduler & {
  fireScheduled(): void;
  pendingCount(): number;
} {
  let nextId = 1;
  const scheduled = new Map<number, () => void>();
  return {
    schedule: (_delayMs, callback) => {
      const id = nextId++;
      scheduled.set(id, callback);
      return { id };
    },
    cancel: (handle: ShutdownDeadlineHandle) => {
      if (typeof handle.id === "number") scheduled.delete(handle.id);
    },
    fireScheduled: () => {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount: () => scheduled.size,
  };
}

describe("server lifecycle", () => {
  test("setupGracefulShutdown registers signal handlers", () => {
    const { handlers, processRef } = createProcess();
    const server = { stop: mock(() => undefined) };
    const target = makeTarget();

    const handle = setupGracefulShutdown(server, target, {
      process: processRef,
      logger: silentLogger,
    });

    expect(processRef.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processRef.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);

    handle.dispose();
    expect(processRef.off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processRef.off).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  test("shutdown delegates to the Host target, stops, then exits", async () => {
    const order: string[] = [];
    const target = makeTarget(mock(async () => {
      order.push("host-shutdown");
    }));
    const server = { stop: mock(() => order.push("stop")) };
    const { handlers, processRef } = createProcess();
    processRef.exit = mock((code?: number): never => {
      order.push(`exit:${code}`);
      throw new ExitError(code);
    });

    const { logger, entries } = createInMemoryLogger();
    const handle = setupGracefulShutdown(server, target, {
      process: processRef,
      logger,
    });
    expect(handlers.has("SIGTERM")).toBe(true);
    await expectExitCode(handle.shutdown("SIGTERM"), 0);

    expect(target.shutdown).toHaveBeenCalled();
    expect(order).toEqual(["host-shutdown", "stop", "exit:0"]);
    expect(entries).toContainEqual(expect.objectContaining({
      level: "info",
      event: "server.shutdown.started",
    }));
  });

  test("shutdown exits with code 1 when its deadline is manually triggered", async () => {
    const server = { stop: mock(() => undefined) };
    const target = makeTarget(mock(async () => {
      await new Promise(() => undefined);
    }));
    const { handlers, processRef } = createProcess();
    const { logger, entries } = createInMemoryLogger();
    const deadlineScheduler = createManualDeadlineScheduler();

    const handle = setupGracefulShutdown(server, target, {
      process: processRef,
      timeoutMs: 10_000,
      logger,
      deadlineScheduler,
    });
    expect(handlers.has("SIGINT")).toBe(true);

    const shutdown = handle.shutdown("SIGINT");
    expect(deadlineScheduler.pendingCount()).toBe(1);
    deadlineScheduler.fireScheduled();
    await expectExitCode(shutdown, 1);
    expect(entries).toContainEqual(expect.objectContaining({
      level: "error",
      event: "server.shutdown.timeout",
      meta: { timeoutMs: 10_000 },
    }));
    expect(server.stop).toHaveBeenCalled();
    expect(deadlineScheduler.pendingCount()).toBe(0);
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
