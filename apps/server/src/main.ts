import { bootServer } from "./boot";
import {
  createConsoleLogger,
  createRuntime,
  type Logger,
  ProjectRegistry,
  RuntimeDataService,
  ServerConfigService,
} from "@archcode/agent-core";
import {
  ENV_ACCESS_LOG,
  ENV_LOG_LEVEL,
  ENV_PORT,
} from "@archcode/protocol";
import {
  requireEmbeddedWebAssets,
  type EmbeddedWebAssets,
} from "./serve-web";
import { resolveCliInvocation } from "./cli";
import { resolveLoggingConfig } from "./logging-config";
import { readSourceProductVersion } from "./product-version";
import { ArchCodeServerHost } from "./server-host";
import { globalEventBus } from "./events/global-event-bus";
import {
  isCompiledRuntime,
  isLauncherChild,
  runServerLauncher,
} from "./launcher";
import { ServerRestartController } from "./restart-controller";
import {
  installManagedCandidate,
  UpdateService,
} from "./updater";

export { createRuntime, type AgentRuntime, type AgentRuntimeOptions } from "@archcode/agent-core";

export interface StartArchCodeOptions {
  embeddedWebAssets?: EmbeddedWebAssets;
  port?: number;
  version?: string;
}

async function main(
  options: StartArchCodeOptions,
  logger: Logger,
  accessLog: boolean,
) {
  const configService = new ServerConfigService();
  const compiled = isCompiledRuntime();
  const restartController = new ServerRestartController();
  const projectRegistry = new ProjectRegistry({
    logger: logger.child({ module: "projects.registry" }),
  });
  const runtimeDataService = new RuntimeDataService({ projectRegistry });
  const updateService = new UpdateService({
    currentVersion: options.version ?? "development",
    executablePath: process.execPath,
    restartSupported: compiled && isLauncherChild(),
    autoCheckEnabled: compiled,
    logger: logger.child({ module: "server.update" }),
    onStatusChange: (status) => {
      globalEventBus.emit({
        type: "update.changed",
        status,
        createdAt: Date.now(),
      });
    },
  });
  await updateService.start();
  const host = await ArchCodeServerHost.create({
    configService,
    createRuntime,
    logger,
    accessLog,
    dev: !compiled,
    embeddedWebAssets: options.embeddedWebAssets,
    version: options.version,
    updateService,
    restartController,
    projectRegistry,
    runtimeDataService,
  });
  await bootServer(host, {
    port: options.port,
    version: options.version,
    logger,
    restartController,
  });
}

export function startArchCode(options: StartArchCodeOptions = {}): void {
  const bootstrapLogger = createConsoleLogger({
    level: "error",
    module: "server",
  });
  let logging: ReturnType<typeof resolveLoggingConfig>;
  try {
    logging = resolveLoggingConfig({
      logLevel: Bun.env[ENV_LOG_LEVEL],
      accessLog: Bun.env[ENV_ACCESS_LOG],
    });
  } catch (error) {
    logFatal(bootstrapLogger, error);
    return;
  }

  const logger = createConsoleLogger({
    level: logging.level,
    module: "server",
  });
  main(options, logger, logging.accessLog).catch((error) => {
    logFatal(logger, error);
  });
}

function logFatal(
  logger: Logger,
  error: unknown,
): void {
  logger.error("server.fatal", {
    message: error instanceof Error ? error.message : "Server startup failed",
    meta: {
      errorName: error instanceof Error ? error.name : "NonErrorThrow",
      errorCode: typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "SERVER_START_FAILED",
    },
  });
  process.exit(1);
}

export interface RunArchCodeCliOptions extends StartArchCodeOptions {
  args: readonly string[];
  version: string;
}

export function runArchCodeCli(options: RunArchCodeCliOptions): void {
  const invocation = resolveCliInvocation(
    options.args,
    options.version,
    Bun.env[ENV_PORT],
  );
  if (invocation.kind === "print") {
    const stream = invocation.stream === "stdout" ? process.stdout : process.stderr;
    stream.write(invocation.output);
    process.exitCode = invocation.exitCode;
    return;
  }

  if (invocation.kind === "install_managed") {
    void commitInstallerCandidate({
      installPath: invocation.installPath,
      version: options.version,
    });
    return;
  }

  if (invocation.kind === "update") {
    void runUpdateCommand({
      checkOnly: invocation.checkOnly,
      version: options.version,
    });
    return;
  }

  if (isCompiledRuntime() && !isLauncherChild()) {
    void runServerLauncher(options.args)
      .then((exitCode) => process.exit(exitCode))
      .catch((error) => logFatal(createConsoleLogger({
        level: "error",
        module: "launcher",
      }), error));
    return;
  }

  startArchCode({
    embeddedWebAssets: options.embeddedWebAssets,
    port: invocation.port,
    version: options.version,
  });
}

async function commitInstallerCandidate(input: {
  installPath: string;
  version: string;
}): Promise<void> {
  try {
    if (!isCompiledRuntime()) {
      throw new Error("Managed installation requires a packaged ArchCode executable");
    }
    await installManagedCandidate({
      candidatePath: process.execPath,
      installPath: input.installPath,
      version: input.version,
    });
  } catch (error) {
    process.stderr.write(
      `archcode installer: ${error instanceof Error ? error.message : "unable to write install receipt"}\n`,
    );
    process.exitCode = 1;
  }
}

async function runUpdateCommand(input: {
  checkOnly: boolean;
  version: string;
}): Promise<void> {
  const logger = createConsoleLogger({
    level: "error",
    module: "update",
  });
  const updateService = new UpdateService({
    currentVersion: input.version,
    executablePath: process.execPath,
    restartSupported: false,
    autoCheckEnabled: false,
    logger,
  });
  try {
    const status = input.checkOnly
      ? await updateService.check()
      : await updateService.install();
    if (input.checkOnly) {
      process.stdout.write(status.updateAvailable && status.latest
        ? `ArchCode v${status.latest.version} is available.\n`
        : `ArchCode v${status.currentVersion} is current.\n`);
    } else if (status.restartRequired && status.latest) {
      process.stdout.write(
        `Installed ArchCode v${status.latest.version}. Restart the running server to use it.\n`,
      );
    } else {
      process.stdout.write(`ArchCode v${status.currentVersion} is current.\n`);
    }
  } catch (error) {
    process.stderr.write(
      `archcode update: ${error instanceof Error ? error.message : "update failed"}\n`,
    );
    process.exitCode = 1;
  } finally {
    await updateService.stop();
  }
}

export function startProductionArchCode(
  embeddedWebAssets: EmbeddedWebAssets,
  options: Omit<RunArchCodeCliOptions, "embeddedWebAssets">,
): void {
  runArchCodeCli({
    ...options,
    embeddedWebAssets: requireEmbeddedWebAssets(embeddedWebAssets),
  });
}

// Only run main() when this source module is the entry point. Production
// binaries use the generated dist/.build entrypoint to inject Web assets.
if (import.meta.main) {
  runArchCodeCli({
    args: Bun.argv.slice(2),
    version: await readSourceProductVersion(),
  });
}
