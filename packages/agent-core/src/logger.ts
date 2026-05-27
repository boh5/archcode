import { formatIsoTime } from "@specra/utils";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = {
  module?: string;
  message?: string;
  context?: Record<string, unknown>;
  error?: unknown;
  meta?: Record<string, unknown>;
};

export interface LogEntry {
  level: LogLevel;
  event: string;
  timestamp: string;
  module?: string;
  message?: string;
  context?: Record<string, unknown>;
  error?: unknown;
  meta?: Record<string, unknown>;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(contextOrModule: string | { module?: string; context?: Record<string, unknown> }): Logger;
}

export interface ConsoleLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type LoggerState = {
  level: LogLevel;
  module?: string;
  context?: Record<string, unknown>;
};

type LogSink = (level: LogLevel, entry: LogEntry) => void;

export function createConsoleLogger(options: {
  level?: LogLevel;
  module?: string;
  context?: Record<string, unknown>;
  console?: ConsoleLike;
} = {}): Logger {
  const sink = options.console ?? console;
  return createLogger(
    {
      level: options.level ?? "info",
      module: options.module,
      context: sanitizeRecord(options.context),
    },
    (level, entry) => {
      const moduleName = entry.module ?? "agent-core";
      const time = formatIsoTime(entry.timestamp);
      sink[level](`[${time}] [specra:${moduleName}] ${entry.event}`, entry);
    },
  );
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

export function createInMemoryLogger(): {
  logger: Logger;
  entries: LogEntry[];
  reset(): void;
} {
  const entries: LogEntry[] = [];
  return {
    logger: createLogger({ level: "debug" }, (_level, entry) => {
      entries.push(entry);
    }),
    entries,
    reset() {
      entries.splice(0, entries.length);
    },
  };
}

export function normalizeError(error: unknown, includeStack = false): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      ...(includeStack && error.stack ? { stack: error.stack } : {}),
    };
  }

  return {
    name: nonErrorName(error),
    message: stringifyNonError(error),
  };
}

function createLogger(state: LoggerState, sink: LogSink): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;

    try {
      const entry = createLogEntry(level, event, state, fields);
      sink(level, entry);
    } catch {
      // Logging must never affect the caller.
    }
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child(contextOrModule) {
      const childModule = typeof contextOrModule === "string"
        ? contextOrModule
        : contextOrModule.module;
      const childContext = typeof contextOrModule === "string"
        ? undefined
        : sanitizeRecord(contextOrModule.context);

      return createLogger(
        {
          level: state.level,
          module: childModule ?? state.module,
          context: mergeContexts(state.context, childContext),
        },
        sink,
      );
    },
  };
}

function createLogEntry(
  level: LogLevel,
  event: string,
  state: LoggerState,
  fields?: LogFields,
): LogEntry {
  const moduleName = fields?.module ?? state.module;
  const context = mergeContexts(state.context, sanitizeRecord(fields?.context));
  const meta = sanitizeRecord(fields?.meta);

  return {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...(moduleName ? { module: moduleName } : {}),
    ...(fields?.message ? { message: fields.message } : {}),
    ...(context ? { context } : {}),
    ...(fields && "error" in fields ? { error: normalizeError(fields.error, level === "error") } : {}),
    ...(meta ? { meta } : {}),
  };
}

function mergeContexts(
  parent?: Record<string, unknown>,
  child?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!parent && !child) return undefined;
  return { ...(parent ?? {}), ...(child ?? {}) };
}

function sanitizeRecord(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) return undefined;

  try {
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      try {
        sanitized[key] = safeSerializeValue(record[key]);
      } catch {
        sanitized[key] = "[Unserializable]";
      }
    }
    return sanitized;
  } catch {
    return { value: "[Unserializable]" };
  }
}

function safeSerializeValue(value: unknown): unknown {
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (typeof nestedValue === "bigint") return nestedValue.toString();
      if (typeof nestedValue === "object" && nestedValue !== null) {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      return nestedValue;
    });

    if (serialized === undefined) return undefined;
    return JSON.parse(serialized) as unknown;
  } catch {
    return "[Unserializable]";
  }
}

function nonErrorName(error: unknown): string {
  if (error === null) return "Null";
  if (error === undefined) return "Undefined";
  return "NonError";
}

function stringifyNonError(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "bigint") return error.toString();
  if (error === undefined) return "undefined";

  try {
    const serialized = safeSerializeValue(error);
    if (typeof serialized === "string") return serialized;
    return JSON.stringify(serialized);
  } catch {
    return String(error);
  }
}
