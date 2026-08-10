import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
} from "@archcode/protocol";
import { sortJsonValue } from "@archcode/utils";
import { ModelRuntime, type ModelRuntimeSnapshot } from "../models";
import {
  MemoryPolicyRuntime,
  type MemoryPolicy,
} from "../memory/policy-runtime";
import { SensitiveValueRedactor } from "../provider/sensitive-value-redactor";
import { atomicWrite } from "../utils/safe-file";
import {
  McpConfigEnvError,
  McpConfigError,
  resolveMcpConfig,
  type ResolvedMcpConfig,
} from "./mcp";
import { collectRuntimeSecretLiterals } from "./runtime-secret-literals";
import {
  MissingProviderOptionError,
  UnsupportedProviderOptionError,
  collectProviderSecretValues,
  providerAdapterCatalog,
  type ProviderAdapter,
  validateProviderAdapterOptions,
} from "./provider-adapter-catalog";
import { findSecretBearingProviderOptionPaths } from "./provider";
import {
  archcodeConfigSchema,
  resolveGithubIntegrationConfig,
  type ArchCodeConfig,
  type AuthConfig,
} from "./schema";

const SERVER_CONFIG_DIRECTORY = ".archcode";
const SERVER_CONFIG_FILE_NAME = "config.json";
const BUILTIN_MCP_NAMES = new Set<string>(BUILTIN_MCP_SERVER_NAMES);
const ACTIVATION_OWNER = Symbol("ServerConfigActivationOwner");

export type ServerAuthCredential = Readonly<AuthConfig> | undefined;

export interface ServerAuthConfigUpdate {
  readonly credential: ServerAuthCredential;
  readonly revision: string;
}

export interface ServerConfigActivation {
  readonly revision: string;
  readonly [ACTIVATION_OWNER]: ServerConfigService;
  readonly runtimeConfig: Omit<ArchCodeConfig, "auth">;
}

export interface ServerConfigInitialization {
  readonly activation: ServerConfigActivation;
  readonly auth: ServerAuthCredential;
}

/** Internal result used by the Host to hot-apply MCP without rereading Config. */
export interface ServerConfigRuntimeSaveResult {
  readonly snapshot: ServerConfigSnapshot;
  readonly resolvedMcpConfig: ResolvedMcpConfig;
}

export type ServerConfigActivationResult =
  | { readonly status: "setup" }
  | {
    readonly status: "ready";
    readonly activation: ServerConfigActivation;
    readonly auth: ServerAuthCredential;
  }
  | { readonly status: "config_error"; readonly error: ConfigSemanticValidationError };

export interface ServerConfigServiceOptions {
  /** Explicit test seam. Production callers construct the service without options. */
  homeDir?: string;
  /** Explicit test seam; production uses one service-owned model runtime. */
  modelRuntime?: ModelRuntime;
  /** Explicit test seam; production uses one service-owned policy runtime. */
  memoryPolicyRuntime?: MemoryPolicyRuntime;
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
    public readonly recovery?: InvalidConfigRecoveryContext,
  ) {
    super(message);
    this.name = "ConfigSemanticValidationError";
  }
}

export interface InvalidConfigRemovalTarget {
  readonly path: readonly string[];
}

export interface InvalidConfigRecoveryContext {
  readonly revision?: string;
  readonly removalTargets: readonly InvalidConfigRemovalTarget[];
}

export interface InvalidConfigRemovalItem {
  readonly id: string;
  readonly path: readonly string[];
}

export interface InvalidConfigRemovalPlan {
  readonly revision?: string;
  readonly items: readonly InvalidConfigRemovalItem[];
}

interface RecoverableConfigValidationIssue extends ServerConfigValidationIssue {
  readonly removalTarget?: InvalidConfigRemovalTarget;
}

export class InvalidConfigRemovalError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly ServerConfigValidationIssue[] = [],
  ) {
    super(message);
    this.name = "InvalidConfigRemovalError";
  }
}

export class ConfigInitializationConflictError extends Error {
  constructor(public readonly configPath: string) {
    super(`Global configuration already exists at ${configPath}`);
    this.name = "ConfigInitializationConflictError";
  }
}

export class ConfigRecoveryConflictError extends Error {
  constructor(public readonly configPath: string) {
    super(`Global configuration at ${configPath} is valid and was not deleted`);
    this.name = "ConfigRecoveryConflictError";
  }
}

class MissingServerConfigError extends Error {}
class ExistingServerConfigError extends Error {}

export class BuiltinMcpConfigNameError extends ConfigSemanticValidationError {
  constructor(name: string) {
    super(
      [{ path: `mcp.servers.${name}`, message: `MCP server name "${name}" is reserved for a built-in server` }],
      undefined,
      { removalTargets: [{ path: ["mcp", "servers", name] }] },
    );
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
  readonly memoryPolicyRuntime: MemoryPolicyRuntime;
  private readonly invalidConfigRemovalSecret = randomBytes(32);
  private startupConfig: ArchCodeConfig | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: ServerConfigServiceOptions = {}) {
    this.homeDir = resolve(options.homeDir ?? homedir());
    this.configPath = resolveServerConfigPath(this.homeDir);
    this.modelRuntime = options.modelRuntime ?? new ModelRuntime();
    this.memoryPolicyRuntime = options.memoryPolicyRuntime ?? new MemoryPolicyRuntime();
  }

  async activateForStartup(): Promise<ServerConfigActivationResult> {
    try {
      const prepared = await this.prepareDiskConfig();
      return {
        status: "ready",
        ...this.activate(
          prepared.config,
          prepared.runtimeRevision,
          prepared.modelRuntime,
        ),
      };
    } catch (error) {
      if (error instanceof MissingServerConfigError) return { status: "setup" };
      if (error instanceof ConfigSemanticValidationError) {
        return {
          status: "config_error",
          error: new ConfigSemanticValidationError(
            error.issues,
            `Invalid global configuration at ${this.configPath}: ${error.message}`,
            error.recovery,
          ),
        };
      }
      throw error;
    }
  }

  async initialize(candidate: unknown): Promise<ServerConfigInitialization> {
    return this.withWriteLock(async () => {
      const validated = validateConfig(materializeInitialConfig(candidate));
      const text = stableJson(validated);
      const runtimeConfig = omitAuth(validated);
      const runtimeRevision = await runtimeRevisionForConfig(validated);
      const prepared = this.prepareModelRuntime(runtimeConfig, runtimeRevision);

      try {
        await createConfigFile(this.configPath, text);
      } catch (cause) {
        if (cause instanceof ExistingServerConfigError) {
          throw new ConfigInitializationConflictError(this.configPath);
        }
        throw new ConfigSemanticValidationError([{
          path: this.configPath,
          message: `Failed to initialize global configuration at ${this.configPath}: ${errorMessage(cause)}`,
        }]);
      }

      return this.activate(validated, runtimeRevision, prepared);
    });
  }

  /** Deletes only the canonical global Config, and only while it is invalid. */
  async discardInvalidConfig(): Promise<void> {
    return this.withWriteLock(async () => {
      try {
        await this.prepareDiskConfig();
      } catch (error) {
        if (error instanceof MissingServerConfigError) return;
        if (!(error instanceof ConfigSemanticValidationError)) throw error;
        return this.claimAndDiscardInvalidConfig();
      }
      throw new ConfigRecoveryConflictError(this.configPath);
    });
  }

  invalidConfigRemovalPlan(
    error: ConfigSemanticValidationError,
  ): InvalidConfigRemovalPlan {
    const recovery = error.recovery;
    if (recovery === undefined) return { items: [] };
    if (recovery.revision === undefined) return { items: [] };
    const revision = recovery.revision;
    return {
      revision,
      items: recovery.removalTargets.map((target) => ({
        id: invalidConfigRemovalId(
          this.invalidConfigRemovalSecret,
          revision,
          target.path,
        ),
        path: target.path,
      })),
    };
  }

  async removeInvalidConfigItems(
    expectedRevision: string,
    itemIds: readonly string[],
  ): Promise<ServerConfigActivationResult> {
    return this.withWriteLock(async () => {
      let currentError: ConfigSemanticValidationError;
      try {
        await this.prepareDiskConfig();
        throw new ConfigRecoveryConflictError(this.configPath);
      } catch (cause) {
        if (cause instanceof MissingServerConfigError) {
          throw new ConfigRecoveryConflictError(this.configPath);
        }
        if (!(cause instanceof ConfigSemanticValidationError)) throw cause;
        currentError = cause;
      }

      const plan = this.invalidConfigRemovalPlan(currentError);
      if (plan.revision === undefined || plan.revision !== expectedRevision) {
        throw new ConfigRevisionConflictError(
          expectedRevision,
          plan.revision ?? "unavailable",
        );
      }
      if (itemIds.length === 0 || new Set(itemIds).size !== itemIds.length) {
        throw new InvalidConfigRemovalError("Select at least one unique invalid Config item.");
      }
      const byId = new Map(plan.items.map((item) => [item.id, item]));
      const selected = itemIds.map((id) => byId.get(id));
      if (selected.some((item) => item === undefined)) {
        throw new ConfigRevisionConflictError(expectedRevision, plan.revision);
      }

      const claimedPath = join(
        dirname(this.configPath),
        `.config-selective-recovery-${crypto.randomUUID()}`,
      );
      try {
        await rename(this.configPath, claimedPath);
      } catch (cause) {
        throw new ConfigRevisionConflictError(expectedRevision, "changed");
      }

      let claimActive = true;
      try {
        const raw = await readFile(claimedPath, "utf8");
        const claimedRevision = await revisionForText(raw);
        if (claimedRevision !== expectedRevision) {
          throw new ConfigRevisionConflictError(expectedRevision, claimedRevision);
        }

        let candidate: unknown;
        try {
          candidate = JSON.parse(raw);
        } catch {
          throw new InvalidConfigRemovalError(
            "This Config is not valid JSON and has no safely removable structured items.",
          );
        }
        const selectedItems = selected as InvalidConfigRemovalItem[];
        const removalPaths = selectedItems
          .map((item) => item.path)
          .filter((path, _index, paths) => !paths.some((candidateAncestor) =>
            candidateAncestor.length < path.length
            && candidateAncestor.every((segment, index) => path[index] === segment)
          ));
        for (const path of removalPaths) {
          deleteConfigPath(candidate, path);
        }

        let validated: ArchCodeConfig;
        try {
          validated = validateConfig(candidate);
          const runtimeRevision = await runtimeRevisionForConfig(validated);
          this.prepareModelRuntime(omitAuth(validated), runtimeRevision);
        } catch (cause) {
          if (cause instanceof ConfigSemanticValidationError) {
            throw new InvalidConfigRemovalError(
              "The selected removals would not produce a valid Config. Select the other related invalid items or repair the file externally.",
              cause.issues,
            );
          }
          throw cause;
        }

        try {
          await createConfigFile(this.configPath, stableJson(validated));
        } catch (cause) {
          if (cause instanceof ExistingServerConfigError) {
            throw new ConfigRevisionConflictError(expectedRevision, "changed");
          }
          throw cause;
        }
        // The no-replace install is the commit point. Cleanup must never turn a
        // committed user operation into a reported failure.
        claimActive = false;
        await unlink(claimedPath).catch(() => undefined);
      } catch (cause) {
        if (claimActive) {
          await restoreClaimedConfig(claimedPath, this.configPath);
          claimActive = false;
        }
        throw cause;
      }
      return this.activateForStartup();
    });
  }

  resolveRuntimeConfig(activation: ServerConfigActivation): Omit<ArchCodeConfig, "auth"> {
    if (activation[ACTIVATION_OWNER] !== this) {
      throw new TypeError("ServerConfigActivation belongs to a different ServerConfigService");
    }
    if (this.modelRuntime.current.revision !== activation.revision) {
      throw new TypeError("ServerConfigActivation is stale");
    }
    return activation.runtimeConfig;
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

  async save(request: UpdateServerConfigRequest): Promise<ServerConfigSnapshot> {
    const result = await this.saveWithRuntimeConfig(request);
    return result.snapshot;
  }

  /**
   * Validate and persist Config once, returning the exact resolved MCP draft
   * that was committed so the Host can hot-apply it without a second read.
   * The atomic file write remains the commit point; ModelRuntime publication
   * happens only after that write succeeds.
   */
  async saveWithRuntimeConfig(
    request: UpdateServerConfigRequest,
  ): Promise<ServerConfigRuntimeSaveResult> {
    return this.withWriteLock(async () => {
      const current = await this.readDiskConfig();
      if (request.expectedRevision !== current.revision) {
        throw new ConfigRevisionConflictError(request.expectedRevision, current.revision);
      }

      const prepared = await prepareSaveCandidate(request.config, current.config, current.revision);
      const {
        validated,
        text,
        unchanged,
        revision,
        runtimeConfig,
        runtimeRevision,
        resolvedMcpConfig,
      } = prepared;
      const runtimeUnchanged = runtimeRevision === this.modelRuntime.current.revision;
      const preparedModelRuntime = runtimeUnchanged
        ? undefined
        : this.prepareModelRuntime(runtimeConfig, runtimeRevision);

      const commit = async (): Promise<void> => {
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
        if (preparedModelRuntime !== undefined) this.modelRuntime.publish(preparedModelRuntime);
      };
      const nextPolicy = memoryPolicyForConfig(validated);
      if (sameMemoryPolicy(this.memoryPolicyRuntime.current.policy, nextPolicy)) {
        await commit();
      } else {
        await this.memoryPolicyRuntime.commitPolicy(nextPolicy, commit);
      }
      return {
        snapshot: {
          config: redactConfig(validated),
          revision,
          modelRuntimeRevision: this.modelRuntime.current.revision,
          configPath: this.configPath,
          restartRequiredSections: restartRequiredSections(validated, this.startupConfig),
        },
        resolvedMcpConfig,
      };
    });
  }

  /**
   * Validate a proposed Config against the current revision and secret policy
   * without writing, publishing, or exposing a masked/serialized snapshot.
   */
  async resolveMcpDraft(request: UpdateServerConfigRequest): Promise<ResolvedMcpConfig> {
    return this.withWriteLock(async () => {
      const current = await this.readDiskConfig();
      if (request.expectedRevision !== current.revision) {
        throw new ConfigRevisionConflictError(request.expectedRevision, current.revision);
      }
      const prepared = await prepareSaveCandidate(request.config, current.config, current.revision);
      return prepared.resolvedMcpConfig;
    });
  }

  async updateAuthPasswordHash(
    passwordHash: string | undefined,
  ): Promise<ServerAuthConfigUpdate> {
    return this.withWriteLock(async () => {
      const current = await this.readDiskConfig();
      const candidate: unknown = passwordHash === undefined
        ? omitAuth(current.config)
        : { ...current.config, auth: { passwordHash } };
      const validated = validateConfig(candidate);
      const text = stableJson(validated);
      const revision = await revisionForText(text);

      if (text !== stableJson(current.config)) {
        try {
          await atomicWrite(this.configPath, text, { mode: 0o600 });
        } catch (cause) {
          throw new ConfigSemanticValidationError([{
            path: this.configPath,
            message: `Failed to write global configuration at ${this.configPath}: ${errorMessage(cause)}`,
          }]);
        }
      }
      const credential = validated.auth === undefined
        ? undefined
        : Object.freeze({ ...validated.auth });
      return { credential, revision };
    });
  }

  private prepareModelRuntime(
    config: Omit<ArchCodeConfig, "auth">,
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

  private activate(
    config: ArchCodeConfig,
    runtimeRevision: string,
    prepared: ModelRuntimeSnapshot = this.prepareModelRuntime(
      omitAuth(config),
      runtimeRevision,
    ),
  ): ServerConfigInitialization {
    this.modelRuntime.publish(prepared);
    this.memoryPolicyRuntime.initialize(memoryPolicyForConfig(config));
    this.startupConfig = config;
    const { auth, ...runtimeConfig } = config;
    return {
      activation: Object.freeze({
        revision: runtimeRevision,
        runtimeConfig: Object.freeze(runtimeConfig),
        [ACTIVATION_OWNER]: this,
      }),
      auth: auth === undefined ? undefined : Object.freeze({ ...auth }),
    };
  }

  private async readDiskConfig(): Promise<{ config: ArchCodeConfig; revision: string }> {
    return this.readConfigFile(this.configPath, true);
  }

  private async readConfigFile(
    sourcePath: string,
    missingMeansSetup: boolean,
  ): Promise<{ config: ArchCodeConfig; revision: string }> {
    let raw: string;
    try {
      raw = await readFile(sourcePath, "utf8");
    } catch (cause) {
      if (
        missingMeansSetup
        && isNodeError(cause, "ENOENT")
        && await pathIsAbsent(sourcePath)
      ) {
        throw new MissingServerConfigError();
      }
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

    const revision = await revisionForText(raw);
    try {
      return { config: validateConfig(json), revision };
    } catch (cause) {
      if (cause instanceof ConfigSemanticValidationError) {
        throw new ConfigSemanticValidationError(
          cause.issues,
          cause.message,
          {
            revision,
            removalTargets: cause.recovery?.removalTargets ?? [],
          },
        );
      }
      throw cause;
    }
  }

  private async prepareDiskConfig(): Promise<{
    config: ArchCodeConfig;
    runtimeRevision: string;
    modelRuntime: ModelRuntimeSnapshot;
  }> {
    return this.prepareConfigFile(this.configPath, true);
  }

  private async prepareConfigFile(
    sourcePath: string,
    missingMeansSetup: boolean,
  ): Promise<{
    config: ArchCodeConfig;
    runtimeRevision: string;
    modelRuntime: ModelRuntimeSnapshot;
  }> {
    const loaded = await this.readConfigFile(sourcePath, missingMeansSetup);
    const runtimeRevision = await runtimeRevisionForConfig(loaded.config);
    try {
      return {
        config: loaded.config,
        runtimeRevision,
        modelRuntime: this.prepareModelRuntime(omitAuth(loaded.config), runtimeRevision),
      };
    } catch (cause) {
      if (cause instanceof ConfigSemanticValidationError) {
        throw new ConfigSemanticValidationError(
          cause.issues,
          cause.message,
          {
            revision: loaded.revision,
            removalTargets: cause.recovery?.removalTargets ?? [],
          },
        );
      }
      throw cause;
    }
  }

  private async claimAndDiscardInvalidConfig(): Promise<void> {
    const claimedPath = join(
      dirname(this.configPath),
      `.config-reset-${crypto.randomUUID()}`,
    );
    try {
      await rename(this.configPath, claimedPath);
    } catch (cause) {
      if (isNodeError(cause, "ENOENT") && await pathIsAbsent(this.configPath)) return;
      throw configDiscardError(this.configPath, cause);
    }

    try {
      await this.prepareConfigFile(claimedPath, false);
    } catch (cause) {
      if (!(cause instanceof ConfigSemanticValidationError)) {
        await restoreClaimedConfig(claimedPath, this.configPath);
        throw cause;
      }
      try {
        await unlink(claimedPath);
      } catch (deleteCause) {
        await restoreClaimedConfig(claimedPath, this.configPath);
        throw configDiscardError(this.configPath, deleteCause);
      }
      if (!(await pathIsAbsent(this.configPath))) {
        throw new ConfigRecoveryConflictError(this.configPath);
      }
      return;
    }

    await restoreClaimedConfig(claimedPath, this.configPath);
    throw new ConfigRecoveryConflictError(this.configPath);
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

interface PreparedSaveCandidate {
  readonly validated: ArchCodeConfig;
  readonly text: string;
  readonly unchanged: boolean;
  readonly revision: string;
  readonly runtimeConfig: Omit<ArchCodeConfig, "auth">;
  readonly runtimeRevision: string;
  readonly resolvedMcpConfig: ResolvedMcpConfig;
}

async function prepareSaveCandidate(
  input: ServerConfigUpdate,
  current: ArchCodeConfig,
  currentRevision: string,
): Promise<PreparedSaveCandidate> {
  validateSecretMutationPayload(input);
  const candidate = applySecretMutations(input, current);
  const validated = validateConfig(candidate);
  const text = stableJson(validated);
  const unchanged = text === stableJson(current);
  const revision = unchanged ? currentRevision : await revisionForText(text);
  const runtimeConfig = omitAuth(validated);
  const runtimeRevision = await runtimeRevisionForConfig(validated);
  const resolvedMcpConfig = resolveMcpConfig(validated.mcp);
  return {
    validated,
    text,
    unchanged,
    revision,
    runtimeConfig,
    runtimeRevision,
    resolvedMcpConfig,
  };
}

function validateConfig(value: unknown): ArchCodeConfig {
  const schema = archcodeConfigSchema.safeParse(value);
  if (!schema.success) {
    throw new ConfigSemanticValidationError(
      schema.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      undefined,
      {
        removalTargets: dedupeRemovalTargets(
          schema.error.issues.flatMap((issue) => schemaIssueRemovalTargets(issue)),
        ),
      },
    );
  }
  const config = schema.data;
  const issues: RecoverableConfigValidationIssue[] = [];

  for (const [providerId, provider] of Object.entries(config.provider)) {
    const adapter = providerAdapterCatalog.get(provider.npm);
    if (!adapter) {
      issues.push({
        path: `provider.${providerId}.npm`,
        message: `Unsupported provider package "${provider.npm}"`,
        removalTarget: { path: ["provider", providerId] },
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
        removalTarget: {
          path: cause instanceof MissingProviderOptionError || cause instanceof UnsupportedProviderOptionError
            ? ["provider", providerId, "options", ...cause.optionPath.split(".")]
            : ["provider", providerId],
        },
      });
    }
    validateAllowedProviderSecretPaths(
      provider.options,
      adapter,
      `provider.${providerId}.options`,
      issues,
      ["provider", providerId, "options"],
    );
    validateCredentialBearingProviderUrls(
      provider.options,
      adapter,
      `provider.${providerId}.options`,
      issues,
      ["provider", providerId, "options"],
    );
  }
  validateSecretValuePlacement(config, issues);

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    const [providerId, ...modelIdParts] = profile.model.split(":");
    const modelId = modelIdParts.join(":");
    const provider = providerId === undefined ? undefined : config.provider[providerId];
    const model = provider === undefined || modelId === "" ? undefined : provider.models[modelId];
    if (!model) {
      issues.push({ path: `profiles.${profileName}.model`, message: `Unknown model reference "${profile.model}"` });
      continue;
    }
  }

  for (const name of Object.keys(config.mcp?.servers ?? {})) {
    if (BUILTIN_MCP_NAMES.has(name)) {
      throw new BuiltinMcpConfigNameError(name);
    }
  }
  try {
    const resolvedMcpConfig = resolveMcpConfig(config.mcp);
    const resolvedGithubConfig = resolveGithubIntegrationConfig(config.integrations?.github);
    validateRuntimeSecretLiteralPolicy(config, resolvedMcpConfig, resolvedGithubConfig, issues);
  } catch (cause) {
    const serverName = mcpErrorServerName(cause, config);
    issues.push({
      path: serverName === undefined
        ? cause instanceof McpConfigError || cause instanceof McpConfigEnvError ? "mcp" : "integrations.github"
        : `mcp.servers.${serverName}`,
      message: errorMessage(cause),
      removalTarget: serverName === undefined
        ? undefined
        : { path: ["mcp", "servers", serverName] },
    });
  }

  if (issues.length > 0) {
    throw new ConfigSemanticValidationError(
      issues,
      undefined,
      {
        removalTargets: dedupeRemovalTargets(
          issues.flatMap((issue) => issue.removalTarget === undefined ? [] : [issue.removalTarget]),
        ),
      },
    );
  }
  return config;
}

/** Validate the complete persisted runtime redaction registry before commit.
 * Transport endpoints/commands are not credentials. */
function validateRuntimeSecretLiteralPolicy(
  config: ArchCodeConfig,
  mcp: ResolvedMcpConfig,
  github: ReturnType<typeof resolveGithubIntegrationConfig>,
  issues: RecoverableConfigValidationIssue[],
): void {
  try {
    collectRuntimeSecretLiterals({
      providers: config.provider,
      userMcp: mcp,
      github,
      // External literals are process inputs, not persisted Config. Their
      // aggregate is validated when createRuntime constructs its registry.
      externalLiterals: [],
    });
  } catch (cause) {
    if (cause instanceof ConfigSemanticValidationError) {
      issues.push(...cause.issues.map((issue) => ({ ...issue })));
      return;
    }
    throw cause;
  }
}

function applySecretMutations(input: ServerConfigUpdate, current: ArchCodeConfig): unknown {
  const candidate = structuredClone(input) as Record<string, any>;
  delete candidate.auth;
  if (current.auth !== undefined) candidate.auth = structuredClone(current.auth);
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
  for (const [name, server] of Object.entries(candidate.mcp?.servers ?? {}) as Array<[string, Record<string, unknown>]>) {
    const field = mcpSecretField(server);
    if (field === undefined) continue;
    const currentServer = current.mcp?.servers[name];
    const currentValues = currentServer === undefined
      ? undefined
      : asStringRecord((currentServer as unknown as Record<string, unknown>)[field]);
    applySecretRecord(
      server,
      field,
      currentValues,
      `mcp.servers.${name}.${field}`,
    );
  }
  return candidate;
}

function mcpSecretField(
  server: { readonly type?: unknown },
): "headers" | "env" | undefined {
  if (server.type === "http") return "headers";
  if (server.type === "stdio") return "env";
  return undefined;
}

function materializeInitialConfig(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const candidate = structuredClone(input);
  const issues: ServerConfigValidationIssue[] = [];
  const providers = isRecord(candidate.provider) ? candidate.provider : {};
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider) || !isRecord(provider.options)) continue;
    const adapter = typeof provider.npm === "string"
      ? providerAdapterCatalog.get(provider.npm)
      : undefined;
    if (!adapter) continue;
    for (const secretPath of adapter.secretPaths) {
      const normalizedPath = secretPath.endsWith(".*")
        ? secretPath.slice(0, -2)
        : secretPath;
      if (secretPath.endsWith(".*")) {
        materializeInitialSecretRecord(
          provider.options,
          normalizedPath,
          `provider.${providerId}.options.${normalizedPath}`,
          issues,
        );
      } else {
        materializeInitialSecret(
          provider.options,
          normalizedPath,
          `provider.${providerId}.options.${normalizedPath}`,
          issues,
        );
      }
    }
  }
  const mcpServers = isRecord(candidate.mcp) && isRecord(candidate.mcp.servers)
    ? candidate.mcp.servers
    : {};
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!isRecord(server)) continue;
    const field = mcpSecretField(server);
    if (field === undefined || server[field] === undefined) continue;
    const mutations = server[field];
    if (!isRecord(mutations)) {
      issues.push({
        path: `mcp.servers.${name}.${field}`,
        message: "Initial secret record must contain replace actions",
      });
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [header, mutation] of Object.entries(mutations)) {
      const path = `mcp.servers.${name}.${field}.${header}`;
      if (!isInitialSecretReplacement(mutation)) {
        issues.push({ path, message: "Initial secret must use a replace action" });
      } else {
        headers[header] = mutation.value;
      }
    }
    server[field] = headers;
  }
  if (issues.length > 0) throw new ConfigSemanticValidationError(issues);
  return candidate;
}

function materializeInitialSecret(
  target: Record<string, unknown>,
  secretPath: string,
  issuePath: string,
  issues: ServerConfigValidationIssue[],
): void {
  const mutation = getPath(target, secretPath);
  if (mutation === undefined) return;
  if (!isInitialSecretReplacement(mutation)) {
    issues.push({ path: issuePath, message: "Initial secret must use a replace action" });
    return;
  }
  setPath(target, secretPath, mutation.value);
}

function materializeInitialSecretRecord(
  target: Record<string, unknown>,
  secretPath: string,
  issuePath: string,
  issues: ServerConfigValidationIssue[],
): void {
  const mutations = getPath(target, secretPath);
  if (mutations === undefined) return;
  if (!isRecord(mutations)) {
    issues.push({ path: issuePath, message: "Initial secret record must contain replace actions" });
    return;
  }
  const materialized: Record<string, string> = {};
  for (const [name, mutation] of Object.entries(mutations)) {
    if (!isInitialSecretReplacement(mutation)) {
      issues.push({
        path: `${issuePath}.${name}`,
        message: "Initial secret must use a replace action",
      });
    } else {
      materialized[name] = mutation.value;
    }
  }
  setPath(target, secretPath, materialized);
}

function isInitialSecretReplacement(
  value: unknown,
): value is { readonly action: "replace"; readonly value: string } {
  return isRecord(value)
    && value.action === "replace"
    && typeof value.value === "string"
    && Object.keys(value).length === 2;
}

function omitAuth(config: ArchCodeConfig): Omit<ArchCodeConfig, "auth"> {
  const { auth: _auth, ...withoutAuth } = config;
  return withoutAuth;
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
    const field = mcpSecretField(server);
    if (field !== undefined) {
      validateSecretMutationRecord(server[field], `mcp.servers.${name}.${field}`, issues);
    }
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
  issues: RecoverableConfigValidationIssue[],
  removalBasePath?: readonly string[],
): void {
  for (const secretPath of findSecretBearingProviderOptionPaths(options, "")) {
    const normalizedPath = secretPath.replace(/^\./, "");
    if (!matchesSecretPath(normalizedPath, adapter.secretPaths, options)) {
      issues.push({
        path: `${basePath}.${normalizedPath}`,
        message: "Secret-bearing provider option is not declared by this adapter",
        removalTarget: removalBasePath === undefined
          ? undefined
          : { path: [...removalBasePath, ...normalizedPath.split(".")] },
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
  issues: RecoverableConfigValidationIssue[],
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
    const values = server.type === "http" ? server.headers : server.env;
    for (const value of Object.values(values ?? {})) {
      if (value.length > 0) secretValues.add(value);
    }
  }
  if (secretValues.size === 0) return;

  const isControlledSecretPath = (segments: readonly string[]): boolean => {
    if (
      segments[0] === "mcp"
      && segments[1] === "servers"
      && (segments[3] === "headers" || segments[3] === "env")
    ) {
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
          removalTarget: boundedRemovalTarget(segments) === undefined
            ? undefined
            : { path: boundedRemovalTarget(segments)! },
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
  issues: RecoverableConfigValidationIssue[],
  removalBasePath?: readonly string[],
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
          removalTarget: removalBasePath === undefined
            ? undefined
            : { path: [...removalBasePath, ...path.split(".")] },
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
  const { auth: _auth, ...editableConfig } = config;
  const view = structuredClone(editableConfig) as unknown as ServerConfigEditableView;
  for (const provider of Object.values(view.provider)) {
    const adapter = providerAdapterCatalog.get(provider.npm);
    if (!adapter || !isRecord(provider.options)) continue;
    redactProviderOptions(provider.options, adapter);
  }
  for (const server of Object.values(view.mcp?.servers ?? {})) {
    if (server.type === "http") redactSecretRecord(server.headers);
    else redactSecretRecord(server.env);
  }
  return view;
}

async function createConfigFile(configPath: string, content: string): Promise<void> {
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = join(directory, `.tmp-${crypto.randomUUID()}`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(tempPath, configPath);
    } catch (cause) {
      if (isNodeError(cause, "EEXIST")) throw new ExistingServerConfigError();
      throw cause;
    }
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function schemaIssueRemovalTargets(issue: {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly keys?: readonly string[];
}): InvalidConfigRemovalTarget[] {
  const path = issue.path.filter(
    (segment): segment is string => typeof segment === "string",
  );
  if (issue.code === "unrecognized_keys" && issue.keys !== undefined) {
    return issue.keys.map((key) => ({ path: [...path, key] }));
  }
  const target = boundedRemovalTarget(path);
  return target === undefined ? [] : [{ path: target }];
}

function boundedRemovalTarget(path: readonly string[]): readonly string[] | undefined {
  const [root] = path;
  if (root === undefined || root === "auth" || root === "profiles") return undefined;
  if (root === "provider") {
    const providerId = path[1];
    if (providerId === undefined) return undefined;
    if (path[2] === "models" && path[3] !== undefined) {
      if (path[4] === "variants" && path[5] !== undefined) {
        return path.slice(0, 6);
      }
      return path.slice(0, 4);
    }
    if (path[2] === "options" && path.length >= 4) return path;
    return path.slice(0, 2);
  }
  if (root === "mcp") {
    if (path[1] === "servers" && path[2] !== undefined) {
      return path.slice(0, 3);
    }
    return undefined;
  }
  if (root === "memory") return ["memory"];
  if (root === "integrations" && path[1] === "github") {
    return ["integrations", "github"];
  }
  return path.length === 1 ? path : undefined;
}

function dedupeRemovalTargets(
  targets: readonly InvalidConfigRemovalTarget[],
): InvalidConfigRemovalTarget[] {
  const byPath = new Map<string, InvalidConfigRemovalTarget>();
  for (const target of targets) {
    byPath.set(JSON.stringify(target.path), target);
  }
  return [...byPath.values()];
}

function invalidConfigRemovalId(
  secret: Uint8Array,
  revision: string,
  path: readonly string[],
): string {
  return createHmac("sha256", secret)
    .update(revision)
    .update("\0")
    .update(JSON.stringify(path))
    .digest("base64url")
    .slice(0, 22);
}

function mcpErrorServerName(
  error: unknown,
  config: ArchCodeConfig,
): string | undefined {
  if (error instanceof McpConfigError) return error.serverName;
  if (!(error instanceof McpConfigEnvError)) return undefined;
  return Object.keys(config.mcp?.servers ?? {})
    .sort((left, right) => right.length - left.length)
    .find((serverName) => {
      const prefix = `mcp.servers.${serverName}`;
      return error.configPath === prefix || error.configPath.startsWith(`${prefix}.`);
    });
}

function deleteConfigPath(candidate: unknown, path: readonly string[]): void {
  if (!isRecord(candidate) || path.length === 0) {
    throw new InvalidConfigRemovalError("The selected invalid Config item is no longer removable.");
  }
  let current: Record<string, unknown> = candidate;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      throw new InvalidConfigRemovalError("The selected invalid Config item is no longer removable.");
    }
    current = next;
  }
  const final = path[path.length - 1]!;
  if (!Object.hasOwn(current, final)) {
    throw new InvalidConfigRemovalError("The selected invalid Config item is no longer removable.");
  }
  delete current[final];
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (cause) {
    return isNodeError(cause, "ENOENT");
  }
}

async function restoreClaimedConfig(
  claimedPath: string,
  configPath: string,
): Promise<void> {
  try {
    await link(claimedPath, configPath);
  } catch (cause) {
    if (isNodeError(cause, "EEXIST")) {
      await unlink(claimedPath).catch(() => undefined);
      return;
    }
    const claimedBytes = await readFile(claimedPath);
    let handle;
    try {
      handle = await open(configPath, "wx", 0o600);
    } catch (createCause) {
      if (isNodeError(createCause, "EEXIST")) {
        await unlink(claimedPath).catch(() => undefined);
        return;
      }
      throw configRestoreError(configPath, claimedPath, createCause);
    }
    try {
      await handle.writeFile(claimedBytes);
      await handle.sync();
    } catch (writeCause) {
      await handle.close().catch(() => undefined);
      await unlink(configPath).catch(() => undefined);
      throw configRestoreError(configPath, claimedPath, writeCause);
    }
    await handle.close().catch(() => undefined);
    await unlink(claimedPath).catch(() => undefined);
    return;
  }
  await unlink(claimedPath).catch(() => undefined);
}

function configRestoreError(
  configPath: string,
  claimedPath: string,
  cause: unknown,
): ConfigSemanticValidationError {
  return new ConfigSemanticValidationError([{
    path: configPath,
    message: `Failed to restore the global configuration at ${configPath}: ${errorMessage(cause)}. The original file remains at ${claimedPath}.`,
  }]);
}

function configDiscardError(
  configPath: string,
  cause: unknown,
): ConfigSemanticValidationError {
  return new ConfigSemanticValidationError([{
    path: configPath,
    message: `Failed to delete invalid global configuration at ${configPath}: ${errorMessage(cause)}`,
  }]);
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

async function runtimeRevisionForConfig(config: ArchCodeConfig): Promise<string> {
  return await revisionForText(stableJson({
    provider: config.provider,
    profiles: config.profiles,
  }));
}

function memoryPolicyForConfig(config: ArchCodeConfig): MemoryPolicy {
  return {
    useMemory: config.memory?.useMemory ?? true,
    autoLearning: config.memory?.autoLearning ?? true,
  };
}

function sameMemoryPolicy(left: MemoryPolicy, right: MemoryPolicy): boolean {
  return left.useMemory === right.useMemory
    && left.autoLearning === right.autoLearning;
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
): Array<"integrations.github"> {
  if (!startupConfig) return [];
  const sections: Array<"integrations.github"> = [];
  if (stableJson(config.integrations?.github) !== stableJson(startupConfig.integrations?.github)) {
    sections.push("integrations.github");
  }
  return sections;
}
