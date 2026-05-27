import { mock } from "bun:test";
import type { Logger, LogFields } from "./logger";
import { createInMemoryLogger } from "./logger";

export { createInMemoryLogger };

/**
 * Creates a mock logger where each method is a `bun:test` mock function.
 * `child()` returns the same mock logger so tests can assert inherited usage.
 */
export function createMockLogger(): Logger & {
  debug: ReturnType<typeof mock>;
  info: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
  child: ReturnType<typeof mock>;
} {
  const logger = {
    debug: mock((_event: string, _fields?: LogFields) => {}),
    info: mock((_event: string, _fields?: LogFields) => {}),
    warn: mock((_event: string, _fields?: LogFields) => {}),
    error: mock((_event: string, _fields?: LogFields) => {}),
    child: mock(function() {
      return logger;
    }),
  };

  return logger;
}
