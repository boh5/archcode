import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import type { ArchCodeConfig } from "./schema";
import { archcodeConfigSchema } from "./schema";

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConfigValidationError";
  }
}

/**
 * Parse and validate a raw JSON value as a ArchCode config.
 * Use when the JSON has already been parsed (e.g. from an import or in-memory).
 */
export function parseConfig(
  value: unknown,
  filePath?: string,
  options?: { logger?: Logger },
): ArchCodeConfig {
  const logger = options?.logger ?? silentLogger;
  const result = archcodeConfigSchema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const location = filePath ?? "<inline>";
  const issues = result.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  logger.warn("config.load.validation.failed", {
    context: { filePath: location },
    error: { name: "ConfigValidationError", message: `Invalid config at ${location}` },
  });

  throw new ConfigValidationError(
    `Invalid config at ${location}:\n${issues}`,
    location,
    { cause: result.error },
  );
}
