import { z } from "zod";
import { REDACTION_MARKER } from "../security";
import { expandEnvVars } from "./env";

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const mcpServerNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    "Server name must match ^[A-Za-z0-9_.-]+$ -- no spaces, slashes, or special characters",
  )
  .refine((name) => !name.includes("__"), {
    message: "Server name must not contain '__' (double underscore)",
  });

const mcpServerConfigSchema = z
  .object({
    url: z.string().min(1, "url must not be empty"),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().positive().optional(),
  })
  .strict();

const mcpConfigSchema = z
  .object({
    servers: z.record(mcpServerNameSchema, mcpServerConfigSchema),
  })
  .strict();

// ─── Inferred Types ─────────────────────────────────────────────────────────

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

export interface ResolvedMcpServerConfig {
  url: string;
  headers?: Record<string, string>;
  timeout: number;
}

export interface ResolvedMcpConfig {
  servers: Record<string, ResolvedMcpServerConfig>;
}

// ─── Named Error Classes ────────────────────────────────────────────────────

export class McpConfigError extends Error {
  constructor(
    message: string,
    public readonly serverName?: string,
  ) {
    super(message);
    this.name = "McpConfigError";
  }
}

export class McpConfigEnvError extends Error {
  constructor(
    public readonly variableName: string,
    public readonly configPath: string,
  ) {
    super(
      `Missing environment variable "${variableName}" referenced in ${configPath}`,
    );
    this.name = "McpConfigEnvError";
  }
}

// ─── Env Expansion ───────────────────────────────────────────────────────────

function expandHeaders(
  headers: Record<string, string>,
  configPath: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = expandEnvVars(value, configPath, {
      createMissingError: (variableName, path) => new McpConfigEnvError(variableName, path),
    });
  }
  return result;
}

// ─── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolve an MCP config from the parsed global server configuration.
 *
 * - Applies env expansion to `url` and header values.
 * - Validates URL scheme (only http: / https:).
 * - Fills in the default timeout (30s).
 *
 * Passing `undefined` returns an empty config `{ servers: {} }`.
 */
export function resolveMcpConfig(config?: McpConfig): ResolvedMcpConfig {
  if (!config) {
    return { servers: {} };
  }

  const servers: Record<string, ResolvedMcpServerConfig> = {};

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    const configPath = `mcp.servers.${serverName}`;

    // Expand env vars in url
    const url = expandEnvVars(serverConfig.url, `${configPath}.url`, {
      createMissingError: (variableName, path) => new McpConfigEnvError(variableName, path),
    });

    // Validate URL scheme (must happen after env expansion)
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new McpConfigError(
          `Invalid URL scheme for MCP server "${serverName}": only http: and https: are accepted. ${REDACTION_MARKER}`,
          serverName,
        );
      }
    } catch (err) {
      if (err instanceof McpConfigError) throw err;
      // URL is structurally invalid
      throw new McpConfigError(
        `Invalid URL for MCP server "${serverName}": ${REDACTION_MARKER}`,
        serverName,
      );
    }

    // Expand env vars in headers
    const headers = serverConfig.headers
      ? expandHeaders(serverConfig.headers, configPath)
      : undefined;

    servers[serverName] = {
      url,
      headers,
      timeout: serverConfig.timeout ?? 30000,
    };
  }

  return { servers };
}

// ─── Schema Exports ─────────────────────────────────────────────────────────

export {
  mcpServerNameSchema,
  mcpServerConfigSchema,
  mcpConfigSchema,
};
