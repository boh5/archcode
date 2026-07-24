import { bootServer } from "./boot";
import {
  createConsoleLogger,
  createRuntime,
  type Logger,
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
import { assertRetiredServerPasswordEnvAbsent } from "./legacy-auth-env";

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
  assertRetiredServerPasswordEnvAbsent(Bun.env);
  const configService = new ServerConfigService();
  const compiled = import.meta.url.startsWith("file:///$bunfs/");
  const host = await ArchCodeServerHost.create({
    configService,
    createRuntime,
    logger,
    accessLog,
    dev: !compiled,
    embeddedWebAssets: options.embeddedWebAssets,
    version: options.version,
  });
  await bootServer(host, {
    port: options.port,
    version: options.version,
    logger,
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

  startArchCode({
    embeddedWebAssets: options.embeddedWebAssets,
    port: invocation.port,
    version: options.version,
  });
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
