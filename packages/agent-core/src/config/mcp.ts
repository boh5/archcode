import { z } from "zod";
import {
  BUILTIN_MCP_SERVER_NAMES,
  type BuiltinMcpServerName,
} from "@archcode/protocol";
import { REDACTION_MARKER } from "../security";
import { expandEnvVars } from "./env";

// ─── Defaults and bounds ────────────────────────────────────────────────────

/** Default deadline for opening an MCP transport. */
export const MCP_DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Default deadline for the initial tools/list discovery. */
export const MCP_DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
/** Default deadline for one tools/call operation. */
export const MCP_DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** Every MCP deadline is positive and bounded to thirty minutes. */
export const MCP_MAX_TIMEOUT_MS = 1_800_000;

const timeoutSchema = z
  .number()
  .int()
  .min(1, "timeout must be a positive integer")
  .max(MCP_MAX_TIMEOUT_MS, `timeout must be at most ${MCP_MAX_TIMEOUT_MS}ms`);

const timeoutFields = {
  connectTimeoutMs: timeoutSchema.optional(),
  discoveryTimeoutMs: timeoutSchema.optional(),
  callTimeoutMs: timeoutSchema.optional(),
} as const;

// ─── Names and schemas ──────────────────────────────────────────────────────

const mcpServerNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    "Server name must match ^[A-Za-z0-9_.-]+$ -- no spaces, slashes, or special characters",
  )
  .refine((name) => !name.includes("__"), {
    message: "Server name must not contain '__' (double underscore)",
  });

const mcpHttpServerConfigSchema = z
  .object({
    type: z.literal("http"),
    enabled: z.boolean(),
    url: z.string().min(1, "url must not be empty"),
    headers: z.record(z.string(), z.string()).optional(),
    ...timeoutFields,
  })
  .strict();

const mcpStdioServerConfigSchema = z
  .object({
    type: z.literal("stdio"),
    enabled: z.boolean(),
    command: z.string().min(1, "command must not be empty"),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    ...timeoutFields,
  })
  .strict();

const mcpServerConfigSchema = z.discriminatedUnion("type", [
  mcpHttpServerConfigSchema,
  mcpStdioServerConfigSchema,
]);

const builtinMcpServerNameSchema = z.enum(BUILTIN_MCP_SERVER_NAMES);
const disabledBuiltinsSchema = z
  .array(builtinMcpServerNameSchema)
  .superRefine((names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        message: "disabledBuiltins must not contain duplicate server names",
      });
    }
  })
  .optional();

const mcpConfigSchema = z
  .object({
    disabledBuiltins: disabledBuiltinsSchema,
    servers: z.record(mcpServerNameSchema, mcpServerConfigSchema),
  })
  .strict();

// ─── Inferred types ─────────────────────────────────────────────────────────

export type McpHttpServerConfig = z.infer<typeof mcpHttpServerConfigSchema>;
export type McpStdioServerConfig = z.infer<typeof mcpStdioServerConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

export interface ResolvedMcpHttpServerConfig {
  readonly type: "http";
  readonly enabled: boolean;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly connectTimeoutMs: number;
  readonly discoveryTimeoutMs: number;
  readonly callTimeoutMs: number;
}

export interface ResolvedMcpStdioServerConfig {
  readonly type: "stdio";
  readonly enabled: boolean;
  readonly command: string;
  readonly args: string[];
  readonly env?: Record<string, string>;
  readonly connectTimeoutMs: number;
  readonly discoveryTimeoutMs: number;
  readonly callTimeoutMs: number;
}

export type ResolvedMcpServerConfig =
  | ResolvedMcpHttpServerConfig
  | ResolvedMcpStdioServerConfig;

export interface ResolvedMcpConfig {
  readonly disabledBuiltins: BuiltinMcpServerName[];
  readonly servers: Record<string, ResolvedMcpServerConfig>;
}

// ─── Named error classes ────────────────────────────────────────────────────

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

// ─── Environment expansion ──────────────────────────────────────────────────

function expandString(
  value: string,
  configPath: string,
  env: NodeJS.ProcessEnv,
): string {
  return expandEnvVars(value, configPath, {
    env,
    createMissingError: (variableName, path) => new McpConfigEnvError(variableName, path),
  });
}

function expandRecord(
  values: Record<string, string> | undefined,
  configPath: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (values === undefined) return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    result[key] = expandString(value, `${configPath}.${key}`, env);
  }
  return result;
}

// ─── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolve a parsed MCP config for runtime use.
 *
 * HTTP expands only its URL and header values. STDIO expands only environment
 * values; its command and args are passed literally to the transport (there is
 * no shell, cwd, project-root, or command interpolation layer).
 */
export function resolveMcpConfig(
  config?: McpConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMcpConfig {
  const disabledBuiltins = [...(config?.disabledBuiltins ?? [])];
  validateDisabledBuiltins(disabledBuiltins);

  if (!config) {
    return { disabledBuiltins, servers: {} };
  }

  const servers: Record<string, ResolvedMcpServerConfig> = {};

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    const configPath = `mcp.servers.${serverName}`;
    const timeouts = resolveTimeouts(serverConfig, serverName);

    if (serverConfig.type === "http") {
      const url = expandString(serverConfig.url, `${configPath}.url`, env);
      validateHttpUrl(url, serverName);
      servers[serverName] = {
        type: "http",
        enabled: serverConfig.enabled,
        url,
        headers: expandRecord(serverConfig.headers, `${configPath}.headers`, env),
        ...timeouts,
      };
      continue;
    }

    servers[serverName] = {
      type: "stdio",
      enabled: serverConfig.enabled,
      command: serverConfig.command,
      args: [...(serverConfig.args ?? [])],
      env: expandRecord(serverConfig.env, `${configPath}.env`, env),
      ...timeouts,
    };
  }

  return { disabledBuiltins, servers };
}

function validateDisabledBuiltins(names: readonly string[]): void {
  if (new Set(names).size !== names.length) {
    throw new McpConfigError("disabledBuiltins must not contain duplicate server names");
  }
  const builtins = new Set<string>(BUILTIN_MCP_SERVER_NAMES);
  const invalid = names.find((name) => !builtins.has(name));
  if (invalid !== undefined) {
    throw new McpConfigError(`Unknown disabled built-in MCP server ${REDACTION_MARKER}`);
  }
}

function resolveTimeouts(
  config: McpServerConfig,
  serverName: string,
): Pick<ResolvedMcpServerConfig, "connectTimeoutMs" | "discoveryTimeoutMs" | "callTimeoutMs"> {
  return {
    connectTimeoutMs: resolveTimeout(config.connectTimeoutMs, MCP_DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs", serverName),
    discoveryTimeoutMs: resolveTimeout(config.discoveryTimeoutMs, MCP_DEFAULT_DISCOVERY_TIMEOUT_MS, "discoveryTimeoutMs", serverName),
    callTimeoutMs: resolveTimeout(config.callTimeoutMs, MCP_DEFAULT_CALL_TIMEOUT_MS, "callTimeoutMs", serverName),
  };
}

function resolveTimeout(
  value: number | undefined,
  fallback: number,
  field: string,
  serverName: string,
): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MCP_MAX_TIMEOUT_MS) {
    throw new McpConfigError(
      `Invalid ${field} for MCP server "${serverName}": expected an integer from 1 to ${MCP_MAX_TIMEOUT_MS}. ${REDACTION_MARKER}`,
      serverName,
    );
  }
  return timeout;
}

function validateHttpUrl(url: string, serverName: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new McpConfigError(
        `Invalid URL scheme for MCP server "${serverName}": only http: and https: are accepted. ${REDACTION_MARKER}`,
        serverName,
      );
    }
  } catch (error) {
    if (error instanceof McpConfigError) throw error;
    throw new McpConfigError(
      `Invalid URL for MCP server "${serverName}": ${REDACTION_MARKER}`,
      serverName,
    );
  }
}

// ─── Schema exports ─────────────────────────────────────────────────────────

export {
  builtinMcpServerNameSchema,
  mcpServerNameSchema,
  mcpHttpServerConfigSchema,
  mcpStdioServerConfigSchema,
  mcpServerConfigSchema,
  mcpConfigSchema,
};
