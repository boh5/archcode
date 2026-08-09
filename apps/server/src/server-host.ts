import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import {
  ConfigRecoveryConflictError,
  ConfigRevisionConflictError,
  InvalidConfigRemovalError,
  normalizeError,
} from "@archcode/agent-core";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  Logger,
  ProjectRegistry,
  RuntimeDataService,
  ServerConfigService,
} from "@archcode/agent-core";
import type {
  BootstrapStatus,
  CompleteSetupRequest,
  ConfigRecoveryActionResponse,
  ConfigRecoveryStatus,
  RemoveInvalidConfigItemsRequest,
  ResetInvalidConfigRequest,
  RuntimeDataDeleteResult,
  RuntimeDataDeleteResponse,
  RuntimeDataInspectionResponse,
  RuntimeStatus,
  SetupProviderAdapterCatalogResponse,
} from "@archcode/protocol";
import { createRuntimeApp } from "./app";
import { errorHandler } from "./error-handler";
import { requestLogger } from "./logger";
import {
  assertMutationOrigin,
  readSessionToken,
  readSessionTokenFromRequest,
} from "./auth-http";
import { createAuthRoutes } from "./routes/auth";
import {
  createSetupRoutes,
  requireSetupGrant,
  type CompleteSetupResult,
  type SetupCoordinatorPort,
} from "./routes/setup";
import {
  createConfigRecoveryRoutes,
  safeConfigRecoveryStatus,
  type ConfigRecoveryActionResult,
  type ConfigRecoveryCoordinatorPort,
} from "./routes/config-recovery";
import {
  ServerAuthService,
  type AuthConfigWriter,
} from "./server-auth-service";
import { TerminalGrant } from "./terminal-grant";
import { ServerError, UnauthorizedError } from "./errors";
import {
  createEmbeddedAssetHandler,
  type EmbeddedWebAssets,
} from "./serve-web";
import { globalEventBus } from "./events/global-event-bus";
import { createUpdateRoutes } from "./routes/update";
import type { ServerRestartController } from "./restart-controller";
import type { UpdateService } from "./updater";
import { createConfigRoutes } from "./routes/config";
import {
  createRuntimeControlRoutes,
  type RuntimeControlCoordinatorPort,
} from "./routes/runtime-control";

export type AgentRuntimeFactory = (
  options: AgentRuntimeOptions,
) => Promise<AgentRuntime>;

export interface ServerHostOptions {
  readonly configService: ServerConfigService;
  readonly createRuntime: AgentRuntimeFactory;
  readonly logger: Logger;
  readonly accessLog?: boolean;
  readonly dev?: boolean;
  readonly embeddedWebAssets?: EmbeddedWebAssets;
  readonly version?: string;
  readonly updateService: Pick<
    UpdateService,
    | "getStatus"
    | "check"
    | "install"
    | "stop"
    | "closeAdmissionIfIdle"
    | "reopenAdmission"
  >;
  readonly restartController: ServerRestartController;
  readonly projectRegistry: ProjectRegistry;
  readonly runtimeDataService: Pick<RuntimeDataService, "inspect" | "delete">;
}

function requireRecoveryGrant(authorized: boolean): void {
  if (!authorized) {
    throw new UnauthorizedError("A valid Config Recovery Grant is required");
  }
}

type HostState =
  | { readonly mode: "setup"; readonly grant: TerminalGrant; submitting: boolean }
  | { readonly mode: "ready" }
  | {
    readonly mode: "config_error";
    readonly grant: TerminalGrant;
    readonly recovery: ConfigRecoveryStatus;
  };

type ReadyBootstrapStatus = Extract<BootstrapStatus, { mode: "ready" }>;

/**
 * Owns the single HTTP shell, bootstrap mode and optional Runtime lifecycle.
 * It is also the one narrow first-run use-case coordinator.
 */
export class ArchCodeServerHost implements SetupCoordinatorPort, ConfigRecoveryCoordinatorPort, RuntimeControlCoordinatorPort {
  readonly app: Hono;
  readonly auth: ServerAuthService;
  private readonly options: ServerHostOptions;
  private state: HostState;
  private runtimeStatus: RuntimeStatus | undefined;
  private runtime: AgentRuntime | undefined;
  private runtimeApp: Hono | undefined;
  private uncleanRuntimeCandidate: AgentRuntime | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private initialRuntimeActivationStarted = false;
  private runtimeMutationPending = false;
  private mutationAdmissionOpen = true;
  private activeMutations = 0;

  private constructor(
    options: ServerHostOptions,
    state: HostState,
    runtimeStatus?: RuntimeStatus,
  ) {
    this.options = options;
    this.state = state;
    this.runtimeStatus = runtimeStatus;
    this.auth = new ServerAuthService({
      configWriter: options.configService as AuthConfigWriter,
    });
    this.app = this.createShell();
  }

  static async create(options: ServerHostOptions): Promise<ArchCodeServerHost> {
    const result = await options.configService.activateForStartup();
    if (result.status === "setup") {
      return new ArchCodeServerHost(options, {
        mode: "setup",
        grant: new TerminalGrant(),
        submitting: false,
      });
    }
    if (result.status === "config_error") {
      options.logger.error("server.config.invalid", {
        message: result.error.message,
        meta: { issues: result.error.issues },
      });
      return new ArchCodeServerHost(options, {
        mode: "config_error",
        grant: new TerminalGrant(),
        recovery: safeConfigRecoveryStatus(
          options.configService.configPath,
          result.error.issues,
          options.configService.invalidConfigRemovalPlan(result.error),
        ),
      });
    }

    const host = new ArchCodeServerHost(
      options,
      { mode: "ready" },
      { state: "activating" },
    );
    host.auth.activateCredential(result.auth?.passwordHash);
    return host;
  }

  bootstrapStatus(sessionToken: string | undefined): BootstrapStatus {
    switch (this.state.mode) {
      case "setup":
        return { mode: "setup" };
      case "config_error":
        return {
          mode: "config_error",
          message: "The global configuration is invalid. Open Config Recovery from the server terminal.",
        };
      case "ready":
        return this.readyBootstrapStatus(sessionToken);
    }
  }

  /** Starts the initial Runtime attempt without delaying listener publication. */
  startRuntimeActivation(): void {
    if (this.state.mode !== "ready" || this.runtime !== undefined) return;
    if (this.initialRuntimeActivationStarted) return;
    if (this.runtimeMutationPending) return;
    this.initialRuntimeActivationStarted = true;
    this.runtimeMutationPending = true;
    void this.runHostMutation(async () => {
      try {
        await this.activateRuntimeFromCurrentConfig();
      } finally {
        this.runtimeMutationPending = false;
      }
    }).catch(() => undefined);
  }

  getRuntimeStatus(): RuntimeStatus {
    return this.requireRuntimeStatus();
  }

  async retryRuntime(): Promise<RuntimeStatus> {
    this.assertRuntimeMutationAvailable();
    this.runtimeMutationPending = true;
    try {
      await this.runHostMutation(async () => {
        try {
          await this.activateRuntimeFromCurrentConfig();
        } catch {
          // The current safe error status is the retry result.
        }
      });
      return this.requireRuntimeStatus();
    } finally {
      this.runtimeMutationPending = false;
    }
  }

  async inspectRuntimeData(): Promise<RuntimeDataInspectionResponse> {
    return await this.options.runtimeDataService.inspect();
  }

  async deleteRuntimeData(
    projectSlugs: readonly string[],
  ): Promise<RuntimeDataDeleteResponse> {
    this.assertRuntimeMutationAvailable();
    this.runtimeMutationPending = true;
    try {
      return await this.runHostMutation(async () => {
        const response: RuntimeDataDeleteResult = await this.options.runtimeDataService.delete(
          projectSlugs,
        );
        if (
          response.results.length > 0
          && response.results.every((result) => result.status === "deleted")
        ) {
          try {
            await this.activateRuntimeFromCurrentConfig();
          } catch {
            // Deletion succeeded. Bootstrap carries the resulting Runtime error.
          }
        }
        return {
          ...response,
          runtime: this.requireRuntimeStatus(),
        };
      });
    } finally {
      this.runtimeMutationPending = false;
    }
  }

  getSetupProviderAdapterCatalog(
    authorization: string | undefined,
  ): SetupProviderAdapterCatalogResponse {
    const state = this.requireSetupState();
    requireSetupGrant(state.grant.authorize(authorization));
    return this.options.configService.getProviderAdapterCatalog();
  }

  async completeSetup(
    authorization: string | undefined,
    request: CompleteSetupRequest,
  ): Promise<CompleteSetupResult> {
    const state = this.requireSetupState();
    requireSetupGrant(state.grant.authorize(authorization));
    if (state.submitting) {
      throw new ServerError("SETUP_CONFLICT", "Setup is already activating", 409);
    }
    state.submitting = true;

    let committed = false;
    try {
      let session: ReturnType<ServerAuthService["issueSession"]> | undefined;
      await this.runHostMutation(async () => {
        const passwordHash = request.requireLogin
          ? await this.auth.hashPassword(request.password)
          : undefined;
        const candidate = {
          ...request.config,
          ...(passwordHash === undefined ? {} : { auth: { passwordHash } }),
        };
        const initialized = await this.options.configService.initialize(candidate);
        committed = true;
        state.grant.consume();
        this.auth.activateCredential(initialized.auth?.passwordHash);
        this.state = { mode: "ready" };
        this.runtimeStatus = { state: "activating" };
        session = this.auth.authRequired ? this.auth.issueSession() : undefined;
        try {
          await this.activateRuntimeFromCurrentConfig();
        } catch {
          // A committed Setup is successful even when Runtime startup fails.
          // activateRuntimeFromCurrentConfig records the safe Runtime status.
        }
      });
      return {
        response: {
          status: this.readyBootstrapStatus(session?.token),
        },
        ...(session === undefined ? {} : { session }),
      };
    } catch (error) {
      if (!committed) {
        state.submitting = false;
        throw error;
      }
      throw error;
    }
  }

  getConfigRecoveryStatus(
    authorization: string | undefined,
  ): ConfigRecoveryStatus {
    const state = this.requireConfigRecoveryState();
    requireRecoveryGrant(state.grant.authorize(authorization));
    return state.recovery;
  }

  async retryConfigRecovery(
    authorization: string | undefined,
  ): Promise<ConfigRecoveryActionResult> {
    const initial = this.requireConfigRecoveryState();
    requireRecoveryGrant(initial.grant.authorize(authorization));
    let session: ReturnType<ServerAuthService["issueSession"]> | undefined;
    let response!: ConfigRecoveryActionResponse;
    let activateRuntime = false;

    await this.runHostMutation(async () => {
      const state = this.requireConfigRecoveryState();
      requireRecoveryGrant(state.grant === initial.grant && state.grant.authorize(authorization));
      const current = await this.options.configService.activateForStartup();
      if (current.status === "config_error") {
        const recovery = safeConfigRecoveryStatus(
          this.options.configService.configPath,
          current.error.issues,
          this.options.configService.invalidConfigRemovalPlan(current.error),
        );
        this.state = { mode: "config_error", grant: state.grant, recovery };
        response = {
          status: this.bootstrapStatus(undefined),
          recovery,
        };
        return;
      }
      if (current.status === "setup") {
        this.state = { mode: "setup", grant: state.grant, submitting: false };
        response = { status: { mode: "setup" } };
        return;
      }

      state.grant.consume();
      this.auth.activateCredential(current.auth?.passwordHash);
      this.state = { mode: "ready" };
      this.runtimeStatus = { state: "activating" };
      session = this.auth.authRequired ? this.auth.issueSession() : undefined;
      response = { status: this.readyBootstrapStatus(session?.token) };
      activateRuntime = true;
    });

    if (activateRuntime) this.startRuntimeActivation();
    return {
      response,
      ...(session === undefined ? {} : { session }),
    };
  }

  async removeInvalidConfigItems(
    authorization: string | undefined,
    request: RemoveInvalidConfigItemsRequest,
  ): Promise<ConfigRecoveryActionResult> {
    const initial = this.requireConfigRecoveryState();
    requireRecoveryGrant(initial.grant.authorize(authorization));
    let session: ReturnType<ServerAuthService["issueSession"]> | undefined;
    let response!: ConfigRecoveryActionResponse;
    let activateRuntime = false;

    await this.runHostMutation(async () => {
      const state = this.requireConfigRecoveryState();
      requireRecoveryGrant(state.grant === initial.grant && state.grant.authorize(authorization));
      let current;
      try {
        current = await this.options.configService.removeInvalidConfigItems(
          request.expectedRevision,
          request.itemIds,
        );
      } catch (error) {
        if (error instanceof ConfigRevisionConflictError) {
          throw new ServerError(
            "CONFIG_RECOVERY_CONFLICT",
            "The configuration changed. Reload Config Recovery before removing anything.",
            409,
          );
        }
        if (error instanceof InvalidConfigRemovalError) {
          throw new ServerError(
            "CONFIG_VALIDATION_ERROR",
            "The selected removals would not leave a valid configuration. Nothing was changed.",
            422,
          );
        }
        if (error instanceof ConfigRecoveryConflictError) {
          throw new ServerError(
            "CONFIG_RECOVERY_CONFLICT",
            "The configuration is now valid. Retry configuration instead.",
            409,
          );
        }
        throw error;
      }

      if (current.status === "config_error") {
        const recovery = safeConfigRecoveryStatus(
          this.options.configService.configPath,
          current.error.issues,
          this.options.configService.invalidConfigRemovalPlan(current.error),
        );
        this.state = { mode: "config_error", grant: state.grant, recovery };
        response = { status: this.bootstrapStatus(undefined), recovery };
        return;
      }
      if (current.status === "setup") {
        throw new ServerError(
          "CONFIG_RECOVERY_CONFLICT",
          "The configuration no longer exists. Reload Config Recovery.",
          409,
        );
      }

      state.grant.consume();
      this.auth.activateCredential(current.auth?.passwordHash);
      this.state = { mode: "ready" };
      this.runtimeStatus = { state: "activating" };
      session = this.auth.authRequired ? this.auth.issueSession() : undefined;
      response = { status: this.readyBootstrapStatus(session?.token) };
      activateRuntime = true;
    });

    if (activateRuntime) this.startRuntimeActivation();
    return {
      response,
      ...(session === undefined ? {} : { session }),
    };
  }

  async resetInvalidConfig(
    authorization: string | undefined,
    _request: ResetInvalidConfigRequest,
  ): Promise<ConfigRecoveryActionResult> {
    const initial = this.requireConfigRecoveryState();
    requireRecoveryGrant(initial.grant.authorize(authorization));
    return await this.runHostMutation(async () => {
      const state = this.requireConfigRecoveryState();
      requireRecoveryGrant(state.grant === initial.grant && state.grant.authorize(authorization));
      try {
        await this.options.configService.discardInvalidConfig();
      } catch (error) {
        if (error instanceof ConfigRecoveryConflictError) {
          throw new ServerError(
            "CONFIG_RECOVERY_CONFLICT",
            "The configuration is now valid and was not deleted. Retry configuration instead.",
            409,
          );
        }
        throw error;
      }
      this.state = { mode: "setup", grant: state.grant, submitting: false };
      return { response: { status: { mode: "setup" } } };
    });
  }

  terminalInstructions(baseUrl: string): readonly string[] {
    if (this.state.mode === "ready") return [];
    const localBaseUrl = this.options.dev
      ? "http://localhost:5173"
      : baseUrl;
    const pathname = this.state.mode === "setup" ? "/setup" : "/config-recovery";
    const url = this.state.grant.url(localBaseUrl, pathname);
    const fragment = new URL(url).hash;
    if (this.state.mode === "config_error") {
      return [
        `Repair the invalid global configuration at ${url}`,
        `For a remote HTTPS URL, open /config-recovery${fragment} on that host or use an SSH tunnel.`,
      ];
    }
    return [
      `Complete first-run setup at ${url}`,
      `For a remote HTTPS URL, open /setup${fragment} on that host or use an SSH tunnel.`,
    ];
  }

  async shutdown(reason: string = "server_shutdown"): Promise<void> {
    this.mutationAdmissionOpen = false;
    await this.options.updateService.stop();
    await this.mutationTail;
    const runtime = this.runtime;
    const uncleanRuntimeCandidate = this.uncleanRuntimeCandidate;
    this.runtime = undefined;
    this.runtimeApp = undefined;
    this.uncleanRuntimeCandidate = undefined;
    if (runtime !== undefined) {
      globalEventBus.emit({ type: "shutdown", reason });
      runtime.notifyRuntimeShutdown(reason);
    }
    const runtimes = runtime === undefined
      ? uncleanRuntimeCandidate === undefined ? [] : [uncleanRuntimeCandidate]
      : uncleanRuntimeCandidate === undefined || uncleanRuntimeCandidate === runtime
        ? [runtime]
        : [runtime, uncleanRuntimeCandidate];
    await Promise.all(runtimes.map(async (ownedRuntime) => await ownedRuntime.shutdown()));
  }

  private createShell(): Hono {
    const app = new Hono();
    const httpLogger = this.options.logger.child({ module: "server.http" });
    app.onError((error, context) => errorHandler(error, context, httpLogger));
    if (this.options.accessLog !== false) {
      app.use("*", requestLogger(httpLogger));
    }
    app.use("*", async (c, next) => {
      await next();
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
    });
    app.use("/api/*", async (c, next) => {
      if (isSafeMethod(c.req.method) || c.req.path === "/api/update/restart") {
        await next();
        return;
      }
      const release = this.acquireMutationAdmission();
      try {
        await next();
      } finally {
        release();
      }
    });
    if (this.options.dev) {
      app.use("*", cors({
        origin: "http://localhost:5173",
        credentials: true,
      }));
    }
    app.use("/api/bootstrap", noStore);
    app.use("/api/setup", noStore);
    app.use("/api/setup/*", noStore);
    app.use("/api/config-recovery", noStore);
    app.use("/api/config-recovery/*", noStore);
    app.use("/api/auth/*", noStore);
    app.use("/api/config", noStore);
    app.use("/api/config/*", noStore);
    app.use("/api/update", noStore);
    app.use("/api/update/*", noStore);
    app.use("/api/runtime", noStore);
    app.use("/api/runtime/*", noStore);
    app.use("/api/runtime-data", noStore);
    app.use("/api/runtime-data/*", noStore);

    app.get("/api/health", (c) => c.json({
      ok: true,
      version: this.options.version ?? "development",
    }));
    app.get("/api/bootstrap", (c) => c.json(
      this.bootstrapStatus(readSessionToken(c)),
    ));
    app.route("/api/setup", createSetupRoutes(this, {
      dev: this.options.dev,
    }));
    app.route("/api/config-recovery", createConfigRecoveryRoutes(this, {
      dev: this.options.dev,
    }));
    app.use("/api/auth/*", async (_c, next) => {
      if (this.state.mode !== "ready") {
        throw new ServerError(
          "SERVER_NOT_READY",
          "Authentication is unavailable until ArchCode is ready",
          503,
        );
      }
      await next();
    });
    app.route("/api/auth", createAuthRoutes(this.auth, {
      dev: this.options.dev,
    }));

    const controlPlaneAccess: MiddlewareHandler = async (c, next) => {
      if (this.state.mode !== "ready") {
        throw new ServerError(
          "SERVER_NOT_READY",
          "ArchCode control plane is not available",
          503,
        );
      }
      if (
        this.auth.authRequired
        && !this.auth.authenticate(readSessionToken(c))
      ) {
        throw new UnauthorizedError("Authentication required");
      }
      if (this.auth.authRequired && !isSafeMethod(c.req.method)) {
        assertMutationOrigin(c.req.raw, { dev: this.options.dev });
      }
      await next();
    };
    app.use("/api/config", controlPlaneAccess);
    app.use("/api/config/*", controlPlaneAccess);
    app.route("/api/config", createConfigRoutes({
      getSnapshot: () => this.options.configService.getSnapshot(),
      getModelRuntimeCatalog: () => this.options.configService.getModelRuntimeCatalog(),
      getProviderAdapterCatalog: () => this.options.configService.getProviderAdapterCatalog(),
      save: (request) => this.runHostMutation(
        async () => {
          const saved = await this.options.configService.saveWithRuntimeConfig(request);
          const runtime = this.runtime;
          if (runtime === undefined) {
            return {
              ...saved.snapshot,
              mcpApply: {
                state: "failed" as const,
                error: "Configuration was saved, but the Runtime is unavailable for MCP live apply",
                status: { servers: {} },
              },
            };
          }
          try {
            await runtime.applyMcpConfig(saved.resolvedMcpConfig);
            return {
              ...saved.snapshot,
              mcpApply: {
                state: "applied" as const,
                status: runtime.getMcpServerStatus(),
              },
            };
          } catch (error) {
            this.options.logger.error("server.config.mcp-apply.failed", {
              error: {
                name: error instanceof Error ? error.name : "NonErrorThrow",
              },
            });
            return {
              ...saved.snapshot,
              mcpApply: {
                state: "failed" as const,
                error: "Configuration was saved, but MCP live apply failed",
                status: runtime.getMcpServerStatus(),
              },
            };
          }
        },
      ),
    }));

    const updateAccess: MiddlewareHandler = async (c, next) => {
      if (this.state.mode === "config_error") {
        requireRecoveryGrant(
          this.state.grant.authorize(c.req.header("Authorization")),
        );
        if (!isSafeMethod(c.req.method)) {
          assertMutationOrigin(c.req.raw, { dev: this.options.dev });
        }
        await next();
        return;
      }
      await controlPlaneAccess(c, next);
    };
    app.use("/api/update", updateAccess);
    app.use("/api/update/*", updateAccess);
    app.route("/api/update", createUpdateRoutes({
      updateService: this.options.updateService,
      restartController: this.options.restartController,
      prepareForRestart: () => this.prepareForRestart(),
    }));

    app.use("/api/runtime", controlPlaneAccess);
    app.use("/api/runtime/*", controlPlaneAccess);
    app.use("/api/runtime-data", controlPlaneAccess);
    app.use("/api/runtime-data/*", controlPlaneAccess);
    const runtimeControl = createRuntimeControlRoutes(this);
    app.route("/api/runtime", runtimeControl.runtime);
    app.route("/api/runtime-data", runtimeControl.runtimeData);

    app.all("/api/*", async (c) => {
      if (
        this.auth.authRequired
        && !this.auth.authenticate(readSessionToken(c))
      ) {
        throw new UnauthorizedError("Authentication required");
      }
      if (this.auth.authRequired && !isSafeMethod(c.req.method)) {
        assertMutationOrigin(c.req.raw, { dev: this.options.dev });
      }
      if (this.state.mode !== "ready" || this.runtimeApp === undefined) {
        throw new ServerError(
          "SERVER_NOT_READY",
          "ArchCode Runtime is not available",
          503,
        );
      }
      return await this.runtimeApp.fetch(c.req.raw);
    });

    if (this.options.embeddedWebAssets !== undefined) {
      app.use("/*", createEmbeddedAssetHandler(this.options.embeddedWebAssets));
    }
    return app;
  }

  private requireSetupState(): Extract<HostState, { mode: "setup" }> {
    if (this.state.mode !== "setup") {
      throw new ServerError(
        "SERVER_NOT_READY",
        "First-run setup is not available",
        404,
      );
    }
    return this.state;
  }

  private requireConfigRecoveryState(): Extract<HostState, { mode: "config_error" }> {
    if (this.state.mode !== "config_error") {
      throw new ServerError(
        "SERVER_NOT_READY",
        "Config Recovery is not available",
        404,
      );
    }
    return this.state;
  }

  private acquireMutationAdmission(): () => void {
    if (!this.mutationAdmissionOpen) {
      throw new ServerError(
        "UPDATE_RUNTIME_BUSY",
        "ArchCode is restarting and no longer accepts changes",
        409,
      );
    }
    this.activeMutations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeMutations -= 1;
    };
  }

  private prepareForRestart(): {
    ready: boolean;
    activeFamilyCount?: number;
  } {
    this.mutationAdmissionOpen = false;
    if (this.activeMutations > 0) {
      this.mutationAdmissionOpen = true;
      return { ready: false, activeFamilyCount: this.activeMutations };
    }
    if (!this.options.updateService.closeAdmissionIfIdle()) {
      this.mutationAdmissionOpen = true;
      return { ready: false, activeFamilyCount: 1 };
    }

    if (this.runtimeMutationPending) {
      this.options.updateService.reopenAdmission();
      this.mutationAdmissionOpen = true;
      return { ready: false, activeFamilyCount: 1 };
    }

    try {
      const runtime = this.runtime;
      if (runtime === undefined) {
        return { ready: true };
      }
      const admission = runtime.prepareForRestart();
      if (!admission.ready) {
        this.options.updateService.reopenAdmission();
        this.mutationAdmissionOpen = true;
      }
      return admission;
    } catch (error) {
      this.options.updateService.reopenAdmission();
      this.mutationAdmissionOpen = true;
      throw error;
    }
  }

  private async activateRuntimeFromCurrentConfig(): Promise<void> {
    this.runtimeStatus = { state: "activating" };
    let current: Awaited<ReturnType<ServerConfigService["activateForStartup"]>>;
    try {
      current = await this.options.configService.activateForStartup();
    } catch (error) {
      this.recordRuntimeFailure(error);
      throw error;
    }
    if (current.status !== "ready") {
      const error = new Error(
        current.status === "config_error"
          ? "The current global configuration is invalid"
          : "The current global configuration is missing",
      );
      this.recordRuntimeFailure(error);
      throw error;
    }

    let runtime: AgentRuntime | undefined;
    try {
      runtime = await this.options.createRuntime({
        configService: this.options.configService,
        activation: current.activation,
        projectRegistry: this.options.projectRegistry,
        logger: this.options.logger,
      });
      await runtime.recoverSessionContinuations();
      await runtime.startAutomationSchedulers();
      const runtimeApp = createRuntimeApp(runtime, {
        logger: this.options.logger.child({ module: "server.http" }),
        globalEventStreamLease: (request) => {
          if (!this.auth.authRequired) return undefined;
          const lease = this.auth.openSessionStream(
            readSessionTokenFromRequest(request),
          );
          if (lease === undefined) {
            throw new UnauthorizedError("Authentication required");
          }
          return lease;
        },
      }).app;
      this.runtime = runtime;
      this.runtimeApp = runtimeApp;
      this.runtimeStatus = { state: "ready" };
    } catch (error) {
      if (runtime !== undefined) {
        try {
          await runtime.shutdown();
        } catch (shutdownError) {
          this.options.logger.error("server.runtime.cleanup_failed", {
            message: "Runtime cleanup failed",
            error: shutdownError,
            meta: {
              errorName: shutdownError instanceof Error
                ? shutdownError.name
                : "NonErrorThrow",
              activationError: normalizeError(error, true),
              ...(shutdownError instanceof Error && shutdownError.cause !== undefined
                ? { cause: normalizeError(shutdownError.cause, true) }
                : {}),
            },
          });
          this.uncleanRuntimeCandidate = runtime;
          this.recordRuntimeCleanupFailure(error);
          throw error;
        }
      }
      this.recordRuntimeFailure(error);
      throw error;
    }
  }

  private recordRuntimeFailure(error: unknown): void {
    this.runtime = undefined;
    this.runtimeApp = undefined;
    this.logRuntimeStartFailure(error);
    this.runtimeStatus = {
      state: "error",
      error: {
        message: "ArchCode Runtime could not start. Check Runtime Data or the server log, then retry.",
        recoveryAllowed: true,
      },
    };
  }

  private recordRuntimeCleanupFailure(activationError: unknown): void {
    this.runtime = undefined;
    this.runtimeApp = undefined;
    this.logRuntimeStartFailure(activationError);
    this.runtimeStatus = {
      state: "error",
      error: {
        message: "Runtime cleanup did not complete. Restart ArchCode before retrying or deleting Runtime data.",
        recoveryAllowed: false,
      },
    };
  }

  private logRuntimeStartFailure(error: unknown): void {
    this.options.logger.error("server.runtime.start_failed", {
      message: "Runtime startup failed",
      error,
      meta: {
        errorName: error instanceof Error ? error.name : "NonErrorThrow",
        ...(error instanceof Error && error.cause !== undefined
          ? { cause: normalizeError(error.cause, true) }
          : {}),
      },
    });
  }

  private requireRuntimeStatus(): RuntimeStatus {
    if (this.runtimeStatus === undefined) {
      throw new Error("Ready control plane requires a Runtime status");
    }
    return this.runtimeStatus;
  }

  private assertRuntimeMutationAvailable(): void {
    if (this.state.mode !== "ready") {
      throw new ServerError(
        "SERVER_NOT_READY",
        "ArchCode control plane is not available",
        503,
      );
    }
    const status = this.requireRuntimeStatus();
    if (this.runtimeMutationPending || status.state === "activating") {
      throw new ServerError(
        "RUNTIME_BUSY",
        "ArchCode Runtime activation is already in progress",
        409,
      );
    }
    if (status.state === "ready") {
      throw new ServerError(
        "RUNTIME_BUSY",
        "ArchCode Runtime is already ready",
        409,
      );
    }
    if (!status.error.recoveryAllowed) {
      throw new ServerError(
        "RUNTIME_CLEANUP_INCOMPLETE",
        "Restart ArchCode before retrying or deleting Runtime data",
        409,
      );
    }
  }

  private readyBootstrapStatus(sessionToken: string | undefined): ReadyBootstrapStatus {
    return {
      mode: "ready",
      authRequired: this.auth.authRequired,
      authenticated: this.auth.authenticate(sessionToken),
      runtime: this.requireRuntimeStatus(),
    };
  }

  private runHostMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
