import { bootServer } from "./boot";
import {
  createConsoleLogger,
  createRuntime,
  ServerConfigService,
} from "@archcode/agent-core";
import { ENV_PORT } from "@archcode/protocol";
import {
  requireEmbeddedWebAssets,
  type EmbeddedWebAssets,
} from "./serve-web";
import { resolveCliInvocation } from "./cli";
import { readSourceProductVersion } from "./product-version";
import { ArchCodeServerHost } from "./server-host";
import { assertRetiredServerPasswordEnvAbsent } from "./legacy-auth-env";

export { createRuntime, type AgentRuntime, type AgentRuntimeOptions } from "@archcode/agent-core";

const logger = createConsoleLogger({ level: "info" });

export interface StartArchCodeOptions {
  embeddedWebAssets?: EmbeddedWebAssets;
  port?: number;
  version?: string;
}

async function main(options: StartArchCodeOptions) {
  assertRetiredServerPasswordEnvAbsent(Bun.env);
  const configService = new ServerConfigService();
  const compiled = import.meta.url.startsWith("file:///$bunfs/");
  const host = await ArchCodeServerHost.create({
    configService,
    createRuntime,
    logger,
    dev: !compiled,
    embeddedWebAssets: options.embeddedWebAssets,
    version: options.version,
  });
  await bootServer(host, {
    port: options.port,
    version: options.version,
  });
}

export function startArchCode(options: StartArchCodeOptions = {}): void {
  main(options).catch((err) => {
    logger.error("server.fatal", {
      message: err instanceof Error ? err.message : "Server startup failed",
      meta: {
        errorName: err instanceof Error ? err.name : "NonErrorThrow",
        errorCode: typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
          ? err.code
          : "SERVER_START_FAILED",
      },
    });
    process.exit(1);
  });
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
