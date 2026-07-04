const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

export class ConfigEnvExpansionError extends Error {
  constructor(
    public readonly variableName: string,
    public readonly configPath: string,
  ) {
    super(`Missing environment variable "${variableName}" referenced in ${configPath}`);
    this.name = "ConfigEnvExpansionError";
  }
}

export interface ExpandEnvVarsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly createMissingError?: (variableName: string, configPath: string) => Error;
}

/**
 * Expand `${VAR}` and `${VAR:-default}` patterns in a string.
 *
 * - `${VAR}` throws when env[VAR] is undefined or empty.
 * - `${VAR:-default}` falls back to `default` when env[VAR] is undefined or empty.
 * - No recursive expansion.
 */
export function expandEnvVars(
  value: string,
  configPath: string,
  options: ExpandEnvVarsOptions = {},
): string {
  const env = options.env ?? process.env;
  return value.replace(ENV_VAR_PATTERN, (_match, expression: string) => {
    const colonIdx = expression.indexOf(":-");
    if (colonIdx >= 0) {
      const varName = expression.slice(0, colonIdx);
      const defaultValue = expression.slice(colonIdx + 2);
      const envVal = env[varName];
      if (envVal === undefined || envVal === "") {
        return defaultValue;
      }
      return envVal;
    }

    const varName = expression;
    const envVal = env[varName];
    if (envVal === undefined || envVal === "") {
      throw options.createMissingError?.(varName, configPath) ?? new ConfigEnvExpansionError(varName, configPath);
    }
    return envVal;
  });
}
