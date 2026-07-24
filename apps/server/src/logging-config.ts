import type { LogLevel } from "@archcode/agent-core";
import { ENV_ACCESS_LOG, ENV_LOG_LEVEL } from "@archcode/protocol";

const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

export interface LoggingEnvironment {
  logLevel?: string;
  accessLog?: string;
}

export interface LoggingConfig {
  level: LogLevel;
  accessLog: boolean;
}

export class InvalidLoggingConfigurationError extends Error {
  readonly code = "INVALID_LOGGING_CONFIGURATION";
  readonly environmentVariable: string;
  readonly value: string;

  constructor(environmentVariable: string, value: string) {
    const expected = environmentVariable === ENV_LOG_LEVEL
      ? "debug, info, warn, or error"
      : "on or off";
    super(
      `Invalid ${environmentVariable} value ${JSON.stringify(value)}: expected ${expected}.`,
    );
    this.name = "InvalidLoggingConfigurationError";
    this.environmentVariable = environmentVariable;
    this.value = value;
  }
}

export function resolveLoggingConfig(
  environment: LoggingEnvironment,
): LoggingConfig {
  const level = environment.logLevel ?? "info";
  if (!isLogLevel(level)) {
    throw new InvalidLoggingConfigurationError(ENV_LOG_LEVEL, level);
  }

  const accessLog = environment.accessLog ?? "on";
  if (accessLog !== "on" && accessLog !== "off") {
    throw new InvalidLoggingConfigurationError(ENV_ACCESS_LOG, accessLog);
  }

  return {
    level,
    accessLog: accessLog === "on",
  };
}

function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.has(value as LogLevel);
}
