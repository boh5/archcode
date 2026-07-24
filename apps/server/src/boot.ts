import {
  createConsoleLogger,
  type Logger,
} from "@archcode/agent-core";
import { ENV_OPEN_BROWSER, PRODUCT_DISPLAY_NAME } from "@archcode/protocol";
import { setupGracefulShutdown } from "./lifecycle";
import { startServer } from "./listen";
import type { ArchCodeServerHost } from "./server-host";

export interface BootServerOptions {
  port?: number;
  version?: string;
  logger?: Logger;
}

export async function bootServer(
  host: ArchCodeServerHost,
  options: BootServerOptions = {},
): Promise<void> {
  const logger = options.logger ?? createConsoleLogger({
    level: "info",
    module: "server",
  });
  const { url, server } = await startServer(host.app, {
    port: options.port,
  });
  setupGracefulShutdown(server, host, {
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
  for (const instruction of host.setupInstructions(url)) {
    logger.info("server.setup.required", { message: instruction });
  }

  if (Bun.env[ENV_OPEN_BROWSER]) {
    // Browser opening will be implemented when the web UI workflow is ready.
  }
}
