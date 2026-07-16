import type { AgentRuntime } from "@archcode/agent-core";
import { ENV_OPEN_BROWSER, ENV_PORT, ENV_SERVER_PASSWORD, PRODUCT_DISPLAY_NAME } from "@archcode/protocol";
import { createServerApp } from "./app";
import { setupGracefulShutdown } from "./lifecycle";
import { startServer } from "./listen";

export async function bootServer(runtime: AgentRuntime): Promise<void> {
  const compiled = import.meta.url.startsWith("file:///$bunfs/");
  const dev = !compiled && !Bun.env[ENV_SERVER_PASSWORD];
  const { app } = createServerApp(runtime, {
    dev,
    password: Bun.env[ENV_SERVER_PASSWORD],
  });

  await runtime.recoverSessionContinuations();
  await runtime.recoverProjectTodos();
  await runtime.startAutomationSchedulers();
  const { url, server } = await startServer(app, {
    port: parseInt(Bun.env[ENV_PORT] ?? "4096", 10) || undefined,
  });
  setupGracefulShutdown(server, runtime);

  console.info(`${PRODUCT_DISPLAY_NAME} server running at ${url}`);

  if (Bun.env[ENV_OPEN_BROWSER]) {
    // Browser opening will be implemented when the web UI workflow is ready.
  }
}
