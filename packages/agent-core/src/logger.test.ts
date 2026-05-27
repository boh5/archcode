import { describe, expect, mock, test } from "bun:test";
import {
  createConsoleLogger,
  createInMemoryLogger,
  normalizeError,
  silentLogger,
  type ConsoleLike,
  type LogEntry,
} from "./logger";

function makeConsole(): ConsoleLike & {
  debug: ReturnType<typeof mock>;
  info: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
} {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function entryFrom(call: unknown[]): LogEntry {
  return call[1] as LogEntry;
}

describe("createConsoleLogger", () => {
  test("emits entries with level, event, and ISO timestamp", () => {
    const sink = makeConsole();
    const logger = createConsoleLogger({ console: sink, level: "debug" });

    logger.info("session.started");

    expect(sink.info).toHaveBeenCalledTimes(1);
    const entry = entryFrom(sink.info.mock.calls[0]);
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("session.started");
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  test("omits warn stack and includes error stack when available", () => {
    const sink = makeConsole();
    const logger = createConsoleLogger({ console: sink, level: "debug" });
    const error = new Error("boom");

    logger.warn("warn.error", { error });
    logger.error("error.error", { error });

    const warnError = entryFrom(sink.warn.mock.calls[0]).error as { stack?: string };
    const errorError = entryFrom(sink.error.mock.calls[0]).error as { stack?: string };
    expect(warnError.stack).toBeUndefined();
    expect(errorError.stack).toBe(error.stack);
  });

  test("resolves console sink methods dynamically at log time", () => {
    const sink = makeConsole();
    const logger = createConsoleLogger({ console: sink, level: "debug" });
    const replacement = mock(() => {});

    sink.warn = replacement;
    logger.warn("dynamic.warn");

    expect(replacement).toHaveBeenCalledTimes(1);
  });

  test("does not throw for circular, undefined, null, bigint, or throwing sink", () => {
    const circular: Record<string, unknown> = { name: "circle" };
    circular.self = circular;
    const throwingSink: ConsoleLike = {
      debug: () => { throw new Error("sink failed"); },
      info: () => { throw new Error("sink failed"); },
      warn: () => { throw new Error("sink failed"); },
      error: () => { throw new Error("sink failed"); },
    };
    const logger = createConsoleLogger({ console: throwingSink, level: "debug" });

    expect(() => logger.debug("safe", {
      context: {
        circular,
        missing: undefined,
        empty: null,
        big: 42n,
      },
      meta: { circular, big: 7n },
    })).not.toThrow();
  });

  test("serializes circular and bigint values when sink succeeds", () => {
    const sink = makeConsole();
    const logger = createConsoleLogger({ console: sink, level: "debug" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    logger.info("safe.values", { context: { circular, big: 42n, nil: null } });

    const entry = entryFrom(sink.info.mock.calls[0]);
    expect(entry.context?.big).toBe("42");
    expect(entry.context?.nil).toBeNull();
    expect(JSON.stringify(entry.context)).toContain("[Circular]");
  });

  test("filters levels below the configured threshold", () => {
    const sink = makeConsole();
    const logger = createConsoleLogger({ console: sink, level: "info" });

    logger.debug("hidden");
    logger.info("visible");

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).toHaveBeenCalledTimes(1);
  });

  test("child logger inherits module and merges context", () => {
    const sink = makeConsole();
    const logger = createConsoleLogger({
      console: sink,
      level: "debug",
      module: "parent",
      context: { requestId: "r1", parentOnly: true },
    });

    logger.child({ context: { requestId: "r2", childOnly: true } }).info("child.context");
    logger.child("child-module").info("child.module", { context: { local: true } });

    const contextEntry = entryFrom(sink.info.mock.calls[0]);
    expect(contextEntry.module).toBe("parent");
    expect(contextEntry.context).toEqual({ requestId: "r2", parentOnly: true, childOnly: true });

    const moduleEntry = entryFrom(sink.info.mock.calls[1]);
    expect(moduleEntry.module).toBe("child-module");
    expect(moduleEntry.context).toEqual({ requestId: "r1", parentOnly: true, local: true });
  });
});

describe("silentLogger", () => {
  test("does nothing and child returns itself", () => {
    expect(() => {
      silentLogger.debug("debug");
      silentLogger.info("info");
      silentLogger.warn("warn");
      silentLogger.error("error");
    }).not.toThrow();
    expect(silentLogger.child("child")).toBe(silentLogger);
  });
});

describe("createInMemoryLogger", () => {
  test("collects entries in order and supports reset", () => {
    const { logger, entries, reset } = createInMemoryLogger();

    logger.debug("one");
    logger.error("two", { error: new Error("boom") });

    expect(entries.map((entry) => entry.event)).toEqual(["one", "two"]);
    expect(entries[1].level).toBe("error");
    reset();
    expect(entries).toEqual([]);
  });
});

describe("normalizeError", () => {
  test("normalizes Error objects with stack inclusion policy", () => {
    const error = new TypeError("bad type");

    expect(normalizeError(error)).toEqual({ name: "TypeError", message: "bad type" });
    const normalized = normalizeError(error, true);
    expect(normalized.name).toBe("TypeError");
    expect(normalized.message).toBe("bad type");
    if (error.stack) expect(normalized.stack).toBe(error.stack);
  });

  test("normalizes non-Error values", () => {
    expect(normalizeError("plain failure")).toEqual({ name: "NonError", message: "plain failure" });
    expect(normalizeError(null)).toEqual({ name: "Null", message: "null" });
    expect(normalizeError(undefined)).toEqual({ name: "Undefined", message: "undefined" });
    expect(normalizeError(10n)).toEqual({ name: "NonError", message: "10" });
    expect(normalizeError({ code: "NOPE" })).toEqual({ name: "NonError", message: '{"code":"NOPE"}' });
  });
});
