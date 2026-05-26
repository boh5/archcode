import type { SpecraRuntime } from "@specra/agent-core";
import { createServerApp } from "./app";
import { setupGracefulShutdown } from "./lifecycle";
import { startServer } from "./listen";

export async function bootServer(runtime: SpecraRuntime): Promise<void> {
  const dev = !Bun.env.SPECRA_SERVER_PASSWORD;
  const { app, agentRunner } = createServerApp(runtime, {
    dev,
    password: Bun.env.SPECRA_SERVER_PASSWORD,
  });

  const { url, server } = await startServer(app, {
    port: parseInt(Bun.env.SPECRA_PORT ?? "4096", 10) || undefined,
  });

  setupGracefulShutdown(server, agentRunner, runtime);

  console.info(`Specra server running at ${url}`);

  if (Bun.env.SPECRA_OPEN_BROWSER) {
    // Browser opening will be implemented when the web UI workflow is ready.
  }
}
