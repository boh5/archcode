import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type ConfigSecretMutation,
  BUILTIN_MCP_SERVER_NAMES,
  type ModelRuntimeCatalog,
  type ProviderAdapterCatalog,
  type ServerConfigEditableView,
  type ServerConfigSnapshot,
  type ServerConfigUpdate,
  type ServerConfigValidationIssue,
  type UpdateServerConfigRequest,
  type UpdateServerConfigResponse,
} from "@archcode/protocol";
import { sortJsonValue } from "@archcode/utils";
import { ModelRuntime, type ModelRuntimeSnapshot } from "../models";
import { SensitiveValueRedactor } from "../provider/sensitive-value-redactor";
import { atomicWrite } from "../utils/safe-file";
import { resolveMcpConfig } from "./mcp";
import {
  MissingProviderOptionError,
  UnsupportedProviderOptionError,
  collectProviderSecretValues,
  providerAdapterCatalog,
  type ProviderAdapter,
  validateProviderAdapterOptions,
} from "./provider-adapter-catalog";
import { findSecretBearingProviderOptionPaths } from "./provider";
import { archcodeConfigSchema, type ArchCodeConfig } from "./schema";

const SERVER_CONFIG_DIRECTORY = ".archcode";
const SERVER_CONFIG_FILE_NAME = "config.json";
const BUILTIN_MCP_NAMES = new Set<string>(BUILTIN_MCP_SERVER_NAMES);

export interface ServerConfigServiceOptions {
  /** Explicit test seam. Production callers construct the service without options. */
  homeDir?: string;
  /** Explicit test seam; production uses one service-owned model runtime. */
  modelRuntime?: ModelRuntime;
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
 * Sole owner of the global configuration file and atomic ModelRuntime publish.
 * Non-model restart comparisons retain the immutable startup configuration.
 */
export class ServerConfigService {
  readonly homeDir: string;
  readonly configPath: string;
  readonly modelRuntime: ModelRuntime;
  private startupConfig: ArchCodeConfig | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: ServerConfigServiceOptions = {}) {
    this.homeDir = resolve(options.homeDir ?? homedir());
    this.configPath = resolveServerConfigPath(this.homeDir);
    this.modelRuntime = options.modelRuntime ?? new ModelRuntime();
  }

  async loadForStartup(): Promise<ArchCodeConfig> {
    try {
      const loaded = await this.readDiskConfig();
      const prepared = this.prepareModelRuntime(loaded.config, loaded.revision);
      this.modelRuntime.publish(prepared);
      this.startupConfig = loaded.config;
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
      modelRuntimeRevision: this.modelRuntime.current.revision,
      configPath: this.configPath,
      restartRequiredSections: restartRequiredSections(loaded.config, this.startupConfig),
    };
  }

  getModelRuntimeCatalog(): ModelRuntimeCatalog {
    return this.modelRuntime.current.catalog;
  }

  getProviderAdapterCatalog(): ProviderAdapterCatalog {
    return providerAdapterCatalog.toDto();
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
      const text = stableJson(validated);
      const unchanged = text === stableJson(current.config);
      const revision = unchanged ? current.revision : await revisionForText(text);
      const prepared = this.prepareModelRuntime(validated, revision);

      if (!unchanged) {
        try {
          await atomicWrite(this.configPath, text, { mode: 0o600 });
        } catch (cause) {
          throw new ConfigSemanticValidationError([{
            path: this.configPath,
            message: `Failed to write global configuration at ${this.configPath}: ${errorMessage(cause)}`,
          }]);
        }
      }
      this.modelRuntime.publish(prepared);
      return {
        config: redactConfig(validated),
        revision,
        modelRuntimeRevision: this.modelRuntime.current.revision,
        configPath: this.configPath,
        restartRequiredSections: restartRequiredSections(validated, this.startupConfig),
      };
    });
  }

  private prepareModelRuntime(
    config: ArchCodeConfig,
    revision: string,
  ): ModelRuntimeSnapshot {
    try {
      return this.modelRuntime.prepare(config, revision);
    } catch (cause) {
      const redactor = providerConfigSecretRedactor(config);
      throw new ConfigSemanticValidationError([{
        path: "provider",
        message: `Unable to prepare model runtime: ${redactor.redact(errorMessage(cause))}`,
      }]);
    }
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

function providerConfigSecretRedactor(config: ArchCodeConfig): SensitiveValueRedactor {
  const values: string[] = [];
  for (const provider of Object.values(config.provider)) {
    const adapter = providerAdapterCatalog.get(provider.npm);
    if (adapter) values.push(...collectProviderSecretValues(adapter, provider.options));
  }
  return new SensitiveValueRedactor(values);
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
    const adapter = providerAdapterCatalog.get(provider.npm);
    if (!adapter) {
      issues.push({
        path: `provider.${providerId}.npm`,
        message: `Unsupported provider package "${provider.npm}"`,
      });
      continue;
    }
    try {
      validateProviderAdapterOptions(adapter, provider.options);
    } catch (cause) {
      issues.push({
        path: cause instanceof MissingProviderOptionError || cause instanceof UnsupportedProviderOptionError
          ? `provider.${providerId}.options.${cause.optionPath}`
          : `provider.${providerId}.options`,
        message: errorMessage(cause),
      });
    }
    validateAllowedProviderSecretPaths(
      provider.options,
      adapter,
      `provider.${providerId}.options`,
      issues,
    );
    validateCredentialBearingProviderUrls(
      provider.options,
      adapter,
      `provider.${providerId}.options`,
      issues,
    );
  }
  validateSecretValuePlacement(config, issues);

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
  for (const [providerId, provider] of Object.entries(candidate.provider ?? {}) as Array<[string, { npm?: unknown; options?: Record<string, unknown> }]>) {
    if (!isRecord(provider.options)) continue;
    const adapter = typeof provider.npm === "string"
      ? providerAdapterCatalog.get(provider.npm)
      : undefined;
    if (!adapter) continue;
    const existing = current.provider[providerId];
    const currentOptions = existing?.npm === provider.npm
      ? existing.options as Record<string, unknown>
      : undefined;
    applyProviderSecretMutations(
      provider.options,
      currentOptions,
      adapter,
      `provider.${providerId}.options`,
    );
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
    const adapter = typeof provider.npm === "string"
      ? providerAdapterCatalog.get(provider.npm)
      : undefined;
    if (!adapter) continue;
    validateProviderSecretMutations(
      provider.options,
      adapter,
      `provider.${providerId}.options`,
      issues,
    );
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

function applyProviderSecretMutations(
  target: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
  adapter: ProviderAdapter,
  basePath: string,
): void {
  for (const secretPath of adapter.secretPaths) {
    if (secretPath.endsWith(".*")) {
      applySecretRecordAtPath(
        target,
        secretPath.slice(0, -2),
        current,
        `${basePath}.${secretPath.slice(0, -2)}`,
      );
      continue;
    }
    applySecretPath(target, secretPath, current, `${basePath}.${secretPath}`);
  }
}

function applySecretPath(
  target: Record<string, unknown>,
  secretPath: string,
  current: Record<string, unknown> | undefined,
  path: string,
): void {
  const mutation = getPath(target, secretPath);
  const currentValue = getPath(current, secretPath);
  if (mutation === undefined) {
    if (typeof currentValue === "string") setPath(target, secretPath, currentValue);
    return;
  }
  if (!isSecretMutation(mutation)) return;
  if (mutation.action === "preserve") {
    if (typeof currentValue !== "string") {
      throw new ConfigSemanticValidationError([{ path, message: "Cannot preserve a secret that is not configured" }]);
    }
    setPath(target, secretPath, currentValue);
    return;
  }
  if (mutation.action === "replace") {
    setPath(target, secretPath, mutation.value);
    return;
  }
  deletePath(target, secretPath);
}

function applySecretRecordAtPath(
  target: Record<string, unknown>,
  secretPath: string,
  current: Record<string, unknown> | undefined,
  path: string,
): void {
  const values = getPath(target, secretPath);
  const existing = asStringRecord(getPath(current, secretPath));
  if (values === undefined) {
    if (existing) setPath(target, secretPath, { ...existing });
    return;
  }
  if (!isRecord(values)) return;
  const resolved: Record<string, string> = { ...(existing ?? {}) };
  for (const [name, mutation] of Object.entries(values)) {
    if (!isSecretMutation(mutation)) continue;
    if (mutation.action === "preserve") {
      if (existing?.[name] === undefined) {
        throw new ConfigSemanticValidationError([{ path: `${path}.${name}`, message: "Cannot preserve a secret that is not configured" }]);
      }
      resolved[name] = existing[name];
    } else if (mutation.action === "replace") {
      resolved[name] = mutation.value;
    } else {
      delete resolved[name];
    }
  }
  if (Object.keys(resolved).length === 0) deletePath(target, secretPath);
  else setPath(target, secretPath, resolved);
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

function validateProviderSecretMutations(
  options: Record<string, unknown>,
  adapter: ProviderAdapter,
  basePath: string,
  issues: ServerConfigValidationIssue[],
): void {
  validateAllowedProviderSecretPaths(options, adapter, basePath, issues);
  for (const secretPath of adapter.secretPaths) {
    if (secretPath.endsWith(".*")) {
      validateSecretMutationRecord(
        getPath(options, secretPath.slice(0, -2)),
        `${basePath}.${secretPath.slice(0, -2)}`,
        issues,
      );
      continue;
    }
    validateSecretMutation(
      getPath(options, secretPath),
      `${basePath}.${secretPath}`,
      issues,
    );
  }
}

function validateAllowedProviderSecretPaths(
  options: Record<string, unknown>,
  adapter: ProviderAdapter,
  basePath: string,
  issues: ServerConfigValidationIssue[],
): void {
  for (const secretPath of findSecretBearingProviderOptionPaths(options, "")) {
    const normalizedPath = secretPath.replace(/^\./, "");
    if (!matchesSecretPath(normalizedPath, adapter.secretPaths, options)) {
      issues.push({
        path: `${basePath}.${normalizedPath}`,
        message: "Secret-bearing provider option is not declared by this adapter",
      });
    }
  }
}

function matchesSecretPath(
  path: string,
  patterns: readonly string[],
  options: Record<string, unknown>,
): boolean {
  return patterns.some((pattern) => {
    if (!pattern.endsWith(".*")) {
      return pattern === path
        || (pattern.startsWith(`${path}.`) && isRecord(getPath(options, path)));
    }
    const prefix = pattern.slice(0, -2);
    return path === prefix
      || (path.startsWith(`${prefix}.`) && path.split(".").length === prefix.split(".").length + 1);
  });
}

function validateSecretValuePlacement(
  config: ArchCodeConfig,
  issues: ServerConfigValidationIssue[],
): void {
  const secretValues = new Set<string>();
  for (const provider of Object.values(config.provider)) {
    const adapter = providerAdapterCatalog.get(provider.npm);
    if (!adapter) continue;
    for (const value of collectProviderSecretValues(adapter, provider.options)) {
      if (value.length > 0) secretValues.add(value);
    }
  }
  for (const server of Object.values(config.mcp?.servers ?? {})) {
    for (const value of Object.values(server.headers ?? {})) {
      if (value.length > 0) secretValues.add(value);
    }
  }
  if (secretValues.size === 0) return;

  const isControlledSecretPath = (segments: readonly string[]): boolean => {
    if (segments[0] === "mcp" && segments[1] === "servers" && segments[3] === "headers") {
      return segments.length === 5;
    }
    if (segments[0] !== "provider" || segments[2] !== "options") return false;
    const providerId = segments[1];
    const provider = providerId === undefined ? undefined : config.provider[providerId];
    const adapter = provider === undefined ? undefined : providerAdapterCatalog.get(provider.npm);
    if (!provider || !adapter) return false;
    const optionSegments = segments.slice(3);
    return adapter.secretPaths.some((pattern) => {
      const wildcard = pattern.endsWith(".*");
      const patternSegments = (wildcard ? pattern.slice(0, -2) : pattern).split(".");
      if (wildcard) {
        return optionSegments.length === patternSegments.length + 1
          && patternSegments.every((segment, index) => optionSegments[index] === segment);
      }
      return optionSegments.length === patternSegments.length
        && patternSegments.every((segment, index) => optionSegments[index] === segment);
    });
  };

  const visit = (value: unknown, segments: readonly string[]): void => {
    if (typeof value === "string") {
      if (secretValues.has(value) && !isControlledSecretPath(segments)) {
        issues.push({
          path: segments.join("."),
          message: "Credential values may appear only in declared secret fields",
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...segments, String(index)]));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, [...segments, key]);
    }
  };

  visit(config, []);
}

function validateCredentialBearingProviderUrls(
  options: Record<string, unknown>,
  adapter: ProviderAdapter,
  basePath: string,
  issues: ServerConfigValidationIssue[],
): void {
  const knownUrlPaths = new Set(
    adapter.optionFields.filter((field) => field.kind === "url").map((field) => field.path),
  );

  const visit = (value: unknown, path: string): void => {
    if (path !== "" && matchesSecretPath(path, adapter.secretPaths, options)) return;
    if (typeof value === "string") {
      if (!knownUrlPaths.has(path) && isCredentialBearingUrl(value)) {
        issues.push({
          path: `${basePath}.${path}`,
          message: "Provider URL credentials, query parameters, and fragments are allowed only in declared secret fields",
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, path === "" ? key : `${path}.${key}`);
    }
  };

  visit(options, "");
}

function isCredentialBearingUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== "";
}

function redactConfig(config: ArchCodeConfig): ServerConfigEditableView {
  const view = structuredClone(config) as unknown as ServerConfigEditableView;
  for (const provider of Object.values(view.provider)) {
    const adapter = providerAdapterCatalog.get(provider.npm);
    if (!adapter || !isRecord(provider.options)) continue;
    redactProviderOptions(provider.options, adapter);
  }
  for (const server of Object.values(view.mcp?.servers ?? {})) {
    redactSecretRecord(server.headers);
  }
  return view;
}

function redactProviderOptions(
  options: Record<string, unknown>,
  adapter: ProviderAdapter,
): void {
  for (const secretPath of adapter.secretPaths) {
    if (secretPath.endsWith(".*")) {
      redactSecretRecord(getPath(options, secretPath.slice(0, -2)) as Record<string, unknown> | undefined);
      continue;
    }
    if (getPath(options, secretPath) !== undefined) {
      setPath(options, secretPath, { configured: true });
    }
  }
}

function redactSecretRecord(record: Record<string, unknown> | undefined): void {
  if (!record) return;
  for (const key of Object.keys(record)) record[key] = { configured: true };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
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

function isSecretMutation(value: unknown): value is ConfigSecretMutation {
  if (!isRecord(value) || typeof value.action !== "string") return false;
  if (value.action === "preserve" || value.action === "delete") {
    return Object.keys(value).length === 1;
  }
  return value.action === "replace"
    && Object.keys(value).length === 2
    && typeof value.value === "string";
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current)) return undefined;
    return current[segment];
  }, value);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  const finalKey = segments.pop();
  if (!finalKey) return;
  let current = target;
  for (const segment of segments) {
    const child = current[segment];
    if (!isRecord(child)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[finalKey] = value;
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const segments = path.split(".");
  const finalKey = segments.pop();
  if (!finalKey) return;
  let current: Record<string, unknown> | undefined = target;
  for (const segment of segments) {
    const child: unknown = current?.[segment];
    if (!isRecord(child)) return;
    current = child;
  }
  delete current?.[finalKey];
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string")
    ? Object.fromEntries(entries) as Record<string, string>
    : undefined;
}

function restartRequiredSections(
  config: ArchCodeConfig,
  startupConfig: ArchCodeConfig | undefined,
): Array<"mcp" | "memory" | "integrations.github"> {
  if (!startupConfig) return [];
  const sections: Array<"mcp" | "memory" | "integrations.github"> = [];
  if (stableJson(config.mcp) !== stableJson(startupConfig.mcp)) sections.push("mcp");
  if (stableJson(config.memory) !== stableJson(startupConfig.memory)) sections.push("memory");
  if (stableJson(config.integrations?.github) !== stableJson(startupConfig.integrations?.github)) {
    sections.push("integrations.github");
  }
  return sections;
}
