import type { SpecraRuntime } from "../main";
import { createServerApp } from "./app";
import { startServer } from "./listen";

export async function bootServer(runtime: SpecraRuntime): Promise<void> {
  const dev = !Bun.env.SPECRA_SERVER_PASSWORD;
  const app = createServerApp(runtime, {
    dev,
    password: Bun.env.SPECRA_SERVER_PASSWORD,
  });

  const { url } = await startServer(app, {
    port: parseInt(Bun.env.SPECRA_PORT ?? "4096", 10) || undefined,
  });

  console.info(`Specra server running at ${url}`);

  if (Bun.env.SPECRA_OPEN_BROWSER) {
    // Browser opening will be implemented when the web UI workflow is ready.
  }
}
