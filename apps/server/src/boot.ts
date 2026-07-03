import type { AgentRuntime } from "@archcode/agent-core";
import { createServerApp } from "./app";
import { setupGracefulShutdown } from "./lifecycle";
import { startServer } from "./listen";

export async function bootServer(runtime: AgentRuntime): Promise<void> {
  const compiled = import.meta.url.startsWith("file:///$bunfs/");
  const dev = !compiled && !Bun.env.ARCHCODE_SERVER_PASSWORD;
  const { app } = createServerApp(runtime, {
    dev,
    password: Bun.env.ARCHCODE_SERVER_PASSWORD,
  });

  const { url, server } = await startServer(app, {
    port: parseInt(Bun.env.ARCHCODE_PORT ?? "4096", 10) || undefined,
  });

  await runtime.startLoopSchedulers();
  setupGracefulShutdown(server, runtime);

  console.info(`ArchCode server running at ${url}`);

  if (Bun.env.ARCHCODE_OPEN_BROWSER) {
    // Browser opening will be implemented when the web UI workflow is ready.
  }
}
