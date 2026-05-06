import { readFile } from "node:fs/promises";
import type { SpecraConfig } from "./schema";
import { specraConfigSchema } from "./schema";

export class ConfigLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConfigLoadError";
  }
}

export class ConfigParseError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConfigParseError";
  }
}

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
 * Parse and validate a raw JSON value as a Specra config.
 * Use when the JSON has already been parsed (e.g. from an import or in-memory).
 */
export function parseConfig(
  value: unknown,
  filePath?: string,
): SpecraConfig {
  const result = specraConfigSchema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const location = filePath ?? "<inline>";
  const issues = result.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new ConfigValidationError(
    `Invalid config at ${location}:\n${issues}`,
    location,
    { cause: result.error },
  );
}

export async function loadConfig(filePath: string): Promise<SpecraConfig> {
  let raw: string;

  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new ConfigLoadError(
      `Failed to read config file: ${filePath}`,
      filePath,
      { cause: err },
    );
  }

  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigParseError(
      `Config file contains invalid JSON: ${filePath}`,
      filePath,
      { cause: err },
    );
  }

  return parseConfig(json, filePath);
}
