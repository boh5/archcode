import type { AgentRuntime } from "@archcode/agent-core";
import { ENV_OPEN_BROWSER, ENV_PORT, ENV_SERVER_PASSWORD, PRODUCT_DISPLAY_NAME } from "@archcode/protocol";
import { createServerApp } from "./app";
import { setupGracefulShutdown } from "./lifecycle";
import { startServer } from "./listen";
import type { EmbeddedWebAssets } from "./serve-web";

export interface BootServerOptions {
  embeddedWebAssets?: EmbeddedWebAssets;
  version?: string;
}

export async function bootServer(
  runtime: AgentRuntime,
  options: BootServerOptions = {},
): Promise<void> {
  const compiled = import.meta.url.startsWith("file:///$bunfs/");
  const dev = !compiled && !Bun.env[ENV_SERVER_PASSWORD];
  const { app } = createServerApp(runtime, {
    dev,
    embeddedWebAssets: options.embeddedWebAssets,
    password: Bun.env[ENV_SERVER_PASSWORD],
    version: options.version,
  });

  await runtime.recoverSessionContinuations();
  await runtime.recoverProjectTodos();
  await runtime.startAutomationSchedulers();
  const { url, server } = await startServer(app, {
    port: parseInt(Bun.env[ENV_PORT] ?? "4096", 10) || undefined,
  });
  setupGracefulShutdown(server, runtime);

  const versionLabel = options.version ? ` v${options.version}` : "";
  console.info(`${PRODUCT_DISPLAY_NAME}${versionLabel} server running at ${url}`);

  if (Bun.env[ENV_OPEN_BROWSER]) {
    // Browser opening will be implemented when the web UI workflow is ready.
  }
}
