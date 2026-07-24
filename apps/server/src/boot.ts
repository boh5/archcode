import { ENV_OPEN_BROWSER, PRODUCT_DISPLAY_NAME } from "@archcode/protocol";
import { setupGracefulShutdown } from "./lifecycle";
import { startServer } from "./listen";
import type { ArchCodeServerHost } from "./server-host";

export interface BootServerOptions {
  port?: number;
  version?: string;
}

export async function bootServer(
  host: ArchCodeServerHost,
  options: BootServerOptions = {},
): Promise<void> {
  const { url, server } = await startServer(host.app, {
    port: options.port,
  });
  setupGracefulShutdown(server, host);

  const versionLabel = options.version ? ` v${options.version}` : "";
  console.info(`${PRODUCT_DISPLAY_NAME}${versionLabel} server running at ${url}`);
  for (const instruction of host.setupInstructions(url)) {
    console.info(instruction);
  }

  if (Bun.env[ENV_OPEN_BROWSER]) {
    // Browser opening will be implemented when the web UI workflow is ready.
  }
}
