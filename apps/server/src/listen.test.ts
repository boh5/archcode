import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { startServer, type ServerInfo } from "./listen";

const servers: ServerInfo[] = [];

afterEach(() => {
  for (const info of servers.splice(0)) {
    info.server.stop(true);
  }
});

function createApp(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.text("ok"));
  return app;
}

describe("startServer", () => {
  test("starts on the preferred port when available", async () => {
    const info = await startServer(createApp(), { hostname: "127.0.0.1", port: 0 });
    servers.push(info);

    expect(info.port).toBeGreaterThan(0);
    expect(info.url).toBe(`http://127.0.0.1:${info.port}`);
  });

  test("falls back to a random port when the preferred port is busy", async () => {
    const blocker = await startServer(createApp(), { hostname: "127.0.0.1", port: 0 });
    servers.push(blocker);

    const info = await startServer(createApp(), {
      hostname: "127.0.0.1",
      port: blocker.port,
    });
    servers.push(info);

    expect(info.port).toBeGreaterThan(0);
    expect(info.port).not.toBe(blocker.port);
    expect(info.url).toBe(`http://127.0.0.1:${info.port}`);
  });
});
