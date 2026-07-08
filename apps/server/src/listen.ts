import { ENV_PORT } from "@archcode/protocol";
import type { Hono } from "hono";

export interface StartServerOptions {
  port?: number;
  hostname?: string;
}

export interface ServerInfo {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  port: number;
}

export async function startServer(
  app: Hono,
  options: StartServerOptions = {},
): Promise<ServerInfo> {
  const preferredPort = options.port ?? parseInt(Bun.env[ENV_PORT] ?? "4096", 10);
  const hostname = options.hostname ?? "0.0.0.0";

  try {
    return createServerInfo(app, hostname, preferredPort);
  } catch (err) {
    if (preferredPort === 0) throw err;
    return createServerInfo(app, hostname, 0);
  }
}

function createServerInfo(app: Hono, hostname: string, port: number): ServerInfo {
  const server = Bun.serve({
    port,
    hostname,
    fetch: app.fetch,
    idleTimeout: 0,
  });
  const actualPort = server.port;
  if (actualPort === undefined) {
    server.stop(true);
    throw new Error("Server started without a TCP port");
  }

  return {
    url: `http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${actualPort}`,
    server,
    port: actualPort,
  };
}
