import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  Logger,
  ServerConfigActivation,
  ServerConfigService,
} from "@archcode/agent-core";
import type {
  BootstrapStatus,
  CompleteSetupRequest,
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
  ServerAuthService,
  type AuthConfigWriter,
} from "./server-auth-service";
import { SetupGrant } from "./setup-grant";
import { ServerError, UnauthorizedError } from "./errors";
import {
  createEmbeddedAssetHandler,
  type EmbeddedWebAssets,
} from "./serve-web";
import { globalEventBus } from "./events/global-event-bus";
import { createUpdateRoutes } from "./routes/update";
import type { ServerRestartController } from "./restart-controller";
import type { UpdateService } from "./updater";

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
}

type HostState =
  | { readonly mode: "setup"; readonly grant: SetupGrant }
  | { readonly mode: "activating"; readonly grant: SetupGrant }
  | { readonly mode: "ready" }
  | { readonly mode: "config_error"; readonly message: string }
  | { readonly mode: "startup_error"; readonly message: string };

/**
 * Owns the single HTTP shell, bootstrap mode and optional Runtime lifecycle.
 * It is also the one narrow first-run use-case coordinator.
 */
export class ArchCodeServerHost implements SetupCoordinatorPort {
  readonly app: Hono;
  readonly auth: ServerAuthService;
  private readonly options: ServerHostOptions;
  private state: HostState;
  private runtime: AgentRuntime | undefined;
  private runtimeApp: Hono | undefined;
  private mutationAdmissionOpen = true;
  private activeMutations = 0;

  private constructor(options: ServerHostOptions, state: HostState) {
    this.options = options;
    this.state = state;
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
        grant: new SetupGrant(),
      });
    }
    if (result.status === "config_error") {
      options.logger.error("server.config.invalid", {
        message: result.error.message,
        meta: { issues: result.error.issues },
      });
      return new ArchCodeServerHost(options, {
        mode: "config_error",
        message: "The global configuration is invalid. Repair it and restart ArchCode.",
      });
    }

    const host = new ArchCodeServerHost(options, { mode: "ready" });
    host.auth.activateCredential(result.auth?.passwordHash);
    try {
      await host.activateRuntime(result.activation);
    } catch (error) {
      host.recordStartupFailure(error);
    }
    return host;
  }

  bootstrapStatus(sessionToken: string | undefined): BootstrapStatus {
    switch (this.state.mode) {
      case "setup":
        return { mode: "setup" };
      case "activating":
        return { mode: "activating" };
      case "config_error":
        return { mode: "config_error", message: this.state.message };
      case "startup_error":
        return { mode: "startup_error", message: this.state.message };
      case "ready":
        return {
          mode: "ready",
          authRequired: this.auth.authRequired,
          authenticated: this.auth.authenticate(sessionToken),
        };
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
    this.state = { mode: "activating", grant: state.grant };

    let committed = false;
    try {
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
      await this.activateRuntime(initialized.activation);
      this.state = { mode: "ready" };
      const session = this.auth.authRequired ? this.auth.issueSession() : undefined;
      return {
        response: {
          status: {
            mode: "ready",
            authRequired: this.auth.authRequired,
            authenticated: true,
          },
        },
        ...(session === undefined ? {} : { session }),
      };
    } catch (error) {
      if (!committed) {
        this.state = { mode: "setup", grant: state.grant };
        throw error;
      }
      this.recordStartupFailure(error);
      throw new ServerError(
        "SERVER_NOT_READY",
        "Setup was saved, but ArchCode could not start. Restart after checking the server log.",
        500,
      );
    }
  }

  setupInstructions(baseUrl: string): readonly string[] {
    if (this.state.mode !== "setup") return [];
    const localBaseUrl = this.options.dev
      ? "http://localhost:5173"
      : baseUrl;
    const url = this.state.grant.setupUrl(localBaseUrl);
    const fragment = new URL(url).hash;
    return [
      `Complete first-run setup at ${url}`,
      `For a remote HTTPS URL, open /setup${fragment} on that host or use an SSH tunnel.`,
    ];
  }

  async shutdown(reason: string = "server_shutdown"): Promise<void> {
    this.mutationAdmissionOpen = false;
    await this.options.updateService.stop();
    const runtime = this.runtime;
    this.runtime = undefined;
    this.runtimeApp = undefined;
    if (runtime === undefined) return;
    globalEventBus.emit({ type: "shutdown", reason });
    runtime.notifyRuntimeShutdown(reason);
    await runtime.shutdown();
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
    app.use("/api/auth/*", noStore);
    app.use("/api/update", noStore);
    app.use("/api/update/*", noStore);

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

    const updateAccess: MiddlewareHandler = async (c, next) => {
      if (this.state.mode !== "ready" || this.runtime === undefined) {
        throw new ServerError(
          "SERVER_NOT_READY",
          "ArchCode Runtime is not available",
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
    app.use("/api/update", updateAccess);
    app.use("/api/update/*", updateAccess);
    app.route("/api/update", createUpdateRoutes({
      updateService: this.options.updateService,
      restartController: this.options.restartController,
      prepareForRestart: () => this.prepareForRestart(),
    }));

    app.all("/api/*", async (c) => {
      if (this.state.mode !== "ready" || this.runtimeApp === undefined) {
        throw new ServerError(
          "SERVER_NOT_READY",
          "ArchCode Runtime is not available",
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
      return await this.runtimeApp.fetch(c.req.raw);
    });

    if (this.options.embeddedWebAssets !== undefined) {
      app.use("/*", createEmbeddedAssetHandler(this.options.embeddedWebAssets));
    }
    return app;
  }

  private requireSetupState(): Extract<HostState, { mode: "setup" }> {
    if (this.state.mode === "activating") {
      throw new ServerError("SETUP_CONFLICT", "Setup is already activating", 409);
    }
    if (this.state.mode !== "setup") {
      throw new ServerError(
        "SERVER_NOT_READY",
        "First-run setup is not available",
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

    try {
      const runtime = this.runtime;
      if (runtime === undefined) {
        throw new ServerError(
          "SERVER_NOT_READY",
          "ArchCode Runtime is not available",
          503,
        );
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

  private async activateRuntime(activation: ServerConfigActivation): Promise<void> {
    let runtime: AgentRuntime | undefined;
    try {
      runtime = await this.options.createRuntime({
        configService: this.options.configService,
        activation,
        logger: this.options.logger,
      });
      await runtime.recoverSessionContinuations();
      await runtime.startAutomationSchedulers();
      this.runtime = runtime;
      this.runtimeApp = createRuntimeApp(runtime, {
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
    } catch (error) {
      if (runtime !== undefined) {
        try {
          await runtime.shutdown();
        } catch (shutdownError) {
          this.options.logger.error("server.runtime.cleanup_failed", {
            message: "Runtime cleanup failed",
            meta: {
              errorName: shutdownError instanceof Error
                ? shutdownError.name
                : "NonErrorThrow",
            },
          });
        }
      }
      throw error;
    }
  }

  private recordStartupFailure(error: unknown): void {
    this.runtime = undefined;
    this.runtimeApp = undefined;
    this.options.logger.error("server.runtime.start_failed", {
      message: "Runtime startup failed",
      meta: {
        errorName: error instanceof Error ? error.name : "NonErrorThrow",
      },
    });
    this.state = {
      mode: "startup_error",
      message: "The saved configuration is valid, but ArchCode could not start. Check the server log and restart.",
    };
  }
}

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
