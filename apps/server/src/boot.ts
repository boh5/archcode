import {
  createConsoleLogger,
  type AgentRuntime,
  type Logger,
} from "@archcode/agent-core";
import { ENV_OPEN_BROWSER, ENV_SERVER_PASSWORD, PRODUCT_DISPLAY_NAME } from "@archcode/protocol";
import { createServerApp } from "./app";
import { setupGracefulShutdown } from "./lifecycle";
import { startServer } from "./listen";
import type { EmbeddedWebAssets } from "./serve-web";

export interface BootServerOptions {
  embeddedWebAssets?: EmbeddedWebAssets;
  port?: number;
  version?: string;
  logger?: Logger;
  accessLog?: boolean;
}

export async function bootServer(
  runtime: AgentRuntime,
  options: BootServerOptions = {},
): Promise<void> {
  const compiled = import.meta.url.startsWith("file:///$bunfs/");
  const dev = !compiled && !Bun.env[ENV_SERVER_PASSWORD];
  const logger = options.logger ?? createConsoleLogger({
    level: "info",
    module: "server",
  });
  const { app } = createServerApp(runtime, {
    dev,
    embeddedWebAssets: options.embeddedWebAssets,
    password: Bun.env[ENV_SERVER_PASSWORD],
    version: options.version,
    logger,
    accessLog: options.accessLog,
  });

  await runtime.recoverSessionContinuations();
  await runtime.recoverProjectTodos();
  await runtime.startAutomationSchedulers();
  const { url, server } = await startServer(app, {
    port: options.port,
  });
  setupGracefulShutdown(server, runtime, {
    logger: logger.child({ module: "server.lifecycle" }),
  });

  const versionLabel = options.version ? ` v${options.version}` : "";
  logger.info("server.started", {
    message: `${PRODUCT_DISPLAY_NAME}${versionLabel} server running at ${url}`,
    meta: {
      url,
      ...(options.version ? { version: options.version } : {}),
    },
  });

  if (Bun.env[ENV_OPEN_BROWSER]) {
    // Browser opening will be implemented when the web UI workflow is ready.
  }
}
