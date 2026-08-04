import {
  createConsoleLogger,
  type Logger,
} from "@archcode/agent-core";
import { ENV_OPEN_BROWSER, PRODUCT_DISPLAY_NAME } from "@archcode/protocol";
import { setupGracefulShutdown } from "./lifecycle";
import { startServer } from "./listen";
import type { ArchCodeServerHost } from "./server-host";
import type { ServerRestartController } from "./restart-controller";
import { UPDATE_RESTART_EXIT_CODE } from "./updater";

export interface BootServerOptions {
  port?: number;
  version?: string;
  logger?: Logger;
  restartController?: ServerRestartController;
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
  const lifecycle = setupGracefulShutdown(server, host, {
    logger: logger.child({ module: "server.lifecycle" }),
  });
  options.restartController?.bind(async () => {
    await lifecycle.shutdown({
      reason: "update_restart",
      exitCode: UPDATE_RESTART_EXIT_CODE,
    });
  });

  const versionLabel = options.version ? ` v${options.version}` : "";
  logger.info("server.started", {
    message: `${PRODUCT_DISPLAY_NAME}${versionLabel} server running at ${url}`,
    meta: {
      url,
      ...(options.version ? { version: options.version } : {}),
    },
  });
  for (const instruction of host.terminalInstructions(url)) {
    logger.info("server.terminal_action.required", { message: instruction });
  }

  // The listener is deliberately published before Runtime activation begins.
  // Runtime startup may be slow or fail; the control plane remains responsive.
  host.startRuntimeActivation();

  if (Bun.env[ENV_OPEN_BROWSER]) {
    // Browser opening will be implemented when the web UI workflow is ready.
  }
}
