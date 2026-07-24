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

export class ServerPortInUseError extends Error {
  readonly code = "EADDRINUSE";

  constructor(readonly port: number, options?: ErrorOptions) {
    super(
      `Port ${port} is already in use. Stop the conflicting process or start ArchCode with --port <port>.`,
      options,
    );
    this.name = "ServerPortInUseError";
  }
}

export async function startServer(
  app: Hono,
  options: StartServerOptions = {},
): Promise<ServerInfo> {
  const preferredPort = options.port ?? 4096;
  const hostname = options.hostname ?? "0.0.0.0";

  try {
    return createServerInfo(app, hostname, preferredPort);
  } catch (err) {
    if (
      preferredPort !== 0 &&
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "EADDRINUSE"
    ) {
      throw new ServerPortInUseError(preferredPort, { cause: err });
    }
    throw err;
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
