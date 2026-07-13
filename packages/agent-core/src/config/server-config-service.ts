import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type ConfigSecretMutation,
  BUILTIN_MCP_SERVER_NAMES,
  type ServerConfigEditableView,
  type ServerConfigSnapshot,
  type ServerConfigUpdate,
  type ServerConfigValidationIssue,
  type UpdateServerConfigRequest,
  type UpdateServerConfigResponse,
} from "@archcode/protocol";
import { OPENAI_COMPATIBLE_PROVIDER_PACKAGE } from "./provider";
import { resolveMcpConfig } from "./mcp";
import { archcodeConfigSchema, type ArchCodeConfig } from "./schema";

const SERVER_CONFIG_DIRECTORY = ".archcode";
const SERVER_CONFIG_FILE_NAME = "config.json";
const BUILTIN_MCP_NAMES = new Set<string>(BUILTIN_MCP_SERVER_NAMES);

export interface ServerConfigServiceOptions {
  /** Explicit test seam. Production callers construct the service without options. */
  homeDir?: string;
}

export class ConfigRevisionConflictError extends Error {
  constructor(
    public readonly expectedRevision: string,
    public readonly currentRevision: string,
  ) {
    super("The configuration changed on disk. Reload it before saving.");
    this.name = "ConfigRevisionConflictError";
  }
}

export class ConfigSemanticValidationError extends Error {
  constructor(
    public readonly issues: readonly ServerConfigValidationIssue[],
    message: string = "Configuration validation failed",
  ) {
    super(message);
    this.name = "ConfigSemanticValidationError";
  }
}

export class BuiltinMcpConfigNameError extends ConfigSemanticValidationError {
  constructor(name: string) {
    super([{ path: `mcp.servers.${name}`, message: `MCP server name "${name}" is reserved for a built-in server` }]);
    this.name = "BuiltinMcpConfigNameError";
  }
}

/** Resolve the sole production configuration path, independent of CWD or project. */
export function resolveServerConfigPath(homeDir: string = homedir()): string {
  return resolve(homeDir, SERVER_CONFIG_DIRECTORY, SERVER_CONFIG_FILE_NAME);
}

/**
 * Sole owner of the global configuration file. Runtime obtains an immutable
 * startup snapshot from this service; Settings writes never mutate that snapshot.
 */
export class ServerConfigService {
  readonly homeDir: string;
  readonly configPath: string;
  private startupRevision: string | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: ServerConfigServiceOptions = {}) {
    this.homeDir = resolve(options.homeDir ?? homedir());
    this.configPath = resolveServerConfigPath(this.homeDir);
  }

  async loadForStartup(): Promise<ArchCodeConfig> {
    try {
      const loaded = await this.readDiskConfig();
      this.startupRevision = loaded.revision;
      return loaded.config;
    } catch (error) {
      if (error instanceof ConfigSemanticValidationError) {
        throw new ConfigSemanticValidationError(error.issues, `Invalid global configuration at ${this.configPath}: ${error.message}`);
      }
      throw error;
    }
  }

  async getSnapshot(): Promise<ServerConfigSnapshot> {
    const loaded = await this.readDiskConfig();
    return {
      config: redactConfig(loaded.config),
      revision: loaded.revision,
      configPath: this.configPath,
      restartRequired: this.startupRevision !== undefined && loaded.revision !== this.startupRevision,
    };
  }

  async save(request: UpdateServerConfigRequest): Promise<UpdateServerConfigResponse> {
    return this.withWriteLock(async () => {
      const current = await this.readDiskConfig();
      if (request.expectedRevision !== current.revision) {
        throw new ConfigRevisionConflictError(request.expectedRevision, current.revision);
      }

      validateSecretMutationPayload(request.config);
      const candidate = applySecretMutations(request.config, current.config);
      const validated = validateConfig(candidate);
      if (stableJson(validated) === stableJson(current.config)) {
        return {
          config: redactConfig(current.config),
          revision: current.revision,
          configPath: this.configPath,
          restartRequired: this.startupRevision !== undefined && current.revision !== this.startupRevision,
        };
      }
      await writeConfigAtomically(this.configPath, stableJson(validated));
      const revision = await revisionForText(stableJson(validated));
      return {
        config: redactConfig(validated),
        revision,
        configPath: this.configPath,
        restartRequired: this.startupRevision !== undefined && revision !== this.startupRevision,
      };
    });
  }

  private async readDiskConfig(): Promise<{ config: ArchCodeConfig; revision: string }> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch (cause) {
      throw new ConfigSemanticValidationError([{
        path: this.configPath,
        message: `Failed to read global configuration at ${this.configPath}: ${errorMessage(cause)}`,
      }]);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      throw new ConfigSemanticValidationError([{
        path: this.configPath,
        message: `Invalid JSON in global configuration at ${this.configPath}: ${errorMessage(cause)}`,
      }]);
    }

    return { config: validateConfig(json), revision: await revisionForText(raw) };
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function validateConfig(value: unknown): ArchCodeConfig {
  const schema = archcodeConfigSchema.safeParse(value);
  if (!schema.success) {
    throw new ConfigSemanticValidationError(schema.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })));
  }
  const config = schema.data;
  const issues: ServerConfigValidationIssue[] = [];

  for (const [providerId, provider] of Object.entries(config.provider)) {
    if (provider.npm !== OPENAI_COMPATIBLE_PROVIDER_PACKAGE) {
      issues.push({
        path: `provider.${providerId}.npm`,
        message: `Only "${OPENAI_COMPATIBLE_PROVIDER_PACKAGE}" is supported`,
      });
    }
  }

  for (const [agentName, agent] of Object.entries(config.agents)) {
    const [providerId, ...modelIdParts] = agent.model.split(":");
    const modelId = modelIdParts.join(":");
    const provider = providerId === undefined ? undefined : config.provider[providerId];
    const model = provider === undefined || modelId === "" ? undefined : provider.models[modelId];
    if (!model) {
      issues.push({ path: `agents.${agentName}.model`, message: `Unknown model reference "${agent.model}"` });
      continue;
    }
    if (agent.variant !== undefined && model.variants?.[agent.variant] === undefined) {
      issues.push({ path: `agents.${agentName}.variant`, message: `Unknown variant "${agent.variant}" for model "${agent.model}"` });
    }
  }

  for (const name of Object.keys(config.mcp?.servers ?? {})) {
    if (BUILTIN_MCP_NAMES.has(name)) {
      throw new BuiltinMcpConfigNameError(name);
    }
  }
  try {
    resolveMcpConfig(config.mcp);
  } catch (cause) {
    issues.push({ path: "mcp", message: errorMessage(cause) });
  }

  if (issues.length > 0) throw new ConfigSemanticValidationError(issues);
  return config;
}

function applySecretMutations(input: ServerConfigUpdate, current: ArchCodeConfig): unknown {
  const candidate = structuredClone(input) as Record<string, any>;
  for (const [providerId, provider] of Object.entries(candidate.provider ?? {}) as Array<[string, { options?: Record<string, unknown> }]>) {
    if (!isRecord(provider.options)) continue;
    const existing = current.provider[providerId];
    applySecretField(provider.options, "apiKey", existing?.options.apiKey, `provider.${providerId}.options.apiKey`);
    applySecretRecord(provider.options, "headers", existing?.options.headers, `provider.${providerId}.options.headers`);
    applySecretRecord(provider.options, "queryParams", existing?.options.queryParams, `provider.${providerId}.options.queryParams`);
  }
  for (const [name, server] of Object.entries(candidate.mcp?.servers ?? {}) as Array<[string, { headers?: Record<string, ConfigSecretMutation> }]>) {
    applySecretRecord(
      server as { headers?: Record<string, ConfigSecretMutation> },
      "headers",
      current.mcp?.servers[name]?.headers,
      `mcp.servers.${name}.headers`,
    );
  }
  return candidate;
}

function validateSecretMutationPayload(input: unknown): void {
  if (!isRecord(input)) return;
  const issues: ServerConfigValidationIssue[] = [];
  const providers = isRecord(input.provider) ? input.provider : {};
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider) || !isRecord(provider.options)) continue;
    validateSecretMutation(provider.options.apiKey, `provider.${providerId}.options.apiKey`, issues);
    validateSecretMutationRecord(provider.options.headers, `provider.${providerId}.options.headers`, issues);
    validateSecretMutationRecord(provider.options.queryParams, `provider.${providerId}.options.queryParams`, issues);
  }
  const mcp = isRecord(input.mcp) && isRecord(input.mcp.servers) ? input.mcp.servers : {};
  for (const [name, server] of Object.entries(mcp)) {
    if (!isRecord(server)) continue;
    validateSecretMutationRecord(server.headers, `mcp.servers.${name}.headers`, issues);
  }
  if (issues.length > 0) throw new ConfigSemanticValidationError(issues);
}

function validateSecretMutation(value: unknown, path: string, issues: ServerConfigValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || typeof value.action !== "string") {
    issues.push({ path, message: "Secret mutation must be an action object" });
    return;
  }
  const keys = Object.keys(value).sort();
  if ((value.action === "preserve" || value.action === "delete") && keys.length === 1 && keys[0] === "action") return;
  if (value.action === "replace" && keys.length === 2 && keys[0] === "action" && keys[1] === "value" && typeof value.value === "string") return;
  issues.push({ path, message: "Secret mutation must be preserve, delete, or replace with a string value" });
}

function validateSecretMutationRecord(value: unknown, path: string, issues: ServerConfigValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, message: "Secret mutation record must be an object" });
    return;
  }
  for (const [key, mutation] of Object.entries(value)) validateSecretMutation(mutation, `${path}.${key}`, issues);
}

function applySecretField(target: Record<string, unknown>, key: string, current: string | undefined, path: string): void {
  const mutation = target[key] as ConfigSecretMutation | undefined;
  if (mutation === undefined) {
    if (current !== undefined) target[key] = current;
    return;
  }
  if (mutation.action === "preserve") {
    if (current === undefined) throw new ConfigSemanticValidationError([{ path, message: "Cannot preserve a secret that is not configured" }]);
    target[key] = current;
    return;
  }
  if (mutation.action === "replace") {
    target[key] = mutation.value;
    return;
  }
  delete target[key];
}

function applySecretRecord(
  target: { [key: string]: unknown },
  key: string,
  current: Record<string, string> | undefined,
  path: string,
): void {
  const values = target[key] as Record<string, ConfigSecretMutation> | undefined;
  if (values === undefined) {
    if (current !== undefined) target[key] = { ...current };
    return;
  }
  const resolved: Record<string, string> = { ...current };
  for (const [name, mutation] of Object.entries(values)) {
    if (mutation.action === "preserve") {
      if (current?.[name] === undefined) {
        throw new ConfigSemanticValidationError([{ path: `${path}.${name}`, message: "Cannot preserve a secret that is not configured" }]);
      }
      resolved[name] = current[name];
    } else if (mutation.action === "replace") {
      resolved[name] = mutation.value;
    } else {
      delete resolved[name];
    }
  }
  if (Object.keys(resolved).length === 0) delete target[key];
  else target[key] = resolved;
}

function redactConfig(config: ArchCodeConfig): ServerConfigEditableView {
  const view = structuredClone(config) as unknown as ServerConfigEditableView;
  for (const provider of Object.values(view.provider)) {
    if (provider.options.apiKey !== undefined) provider.options.apiKey = { configured: true };
    redactSecretRecord(provider.options.headers);
    redactSecretRecord(provider.options.queryParams);
  }
  for (const server of Object.values(view.mcp?.servers ?? {})) {
    redactSecretRecord(server.headers);
  }
  return view;
}

function redactSecretRecord(record: Record<string, unknown> | undefined): void {
  if (!record) return;
  for (const key of Object.keys(record)) record[key] = { configured: true };
}

async function writeConfigAtomically(configPath: string, contents: string): Promise<void> {
  const tempPath = join(dirname(configPath), `.${SERVER_CONFIG_FILE_NAME}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, contents, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, configPath);
  } catch (cause) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ConfigSemanticValidationError([{
      path: configPath,
      message: `Failed to write global configuration at ${configPath}: ${errorMessage(cause)}`,
    }]);
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

async function revisionForText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
