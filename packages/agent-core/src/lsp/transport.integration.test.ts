import { afterAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { DEFAULT_FAKE_LSP_CONFIG } from "./fake-server";
import { StdioLspTransport } from "./transport";

const transports: StdioLspTransport[] = [];

function createFakeServerTransport(): StdioLspTransport {
  const transport = new StdioLspTransport({
    command: "bun",
    args: ["run", path.join(import.meta.dir, "fake-server.ts")],
    env: { ...process.env, FAKE_LSP_CONFIG: JSON.stringify(DEFAULT_FAKE_LSP_CONFIG) },
  });
  transports.push(transport);
  return transport;
}

afterAll(async () => {
  await Promise.all(transports.map((transport) => transport.dispose()));
});

describe("StdioLspTransport integration", () => {
  it("connects to the fake server and initializes", async () => {
    const transport = createFakeServerTransport();
    const result = await transport.connect({ processId: null, capabilities: {}, rootUri: null });
    expect(result).toHaveProperty("capabilities");
    expect(result).toHaveProperty("serverInfo");
    expect((result as any).serverInfo).toEqual({ name: "fake-lsp-server", version: "0.0.1" });
    expect((result as any).capabilities).toHaveProperty("definitionProvider", true);
    expect((result as any).capabilities).not.toHaveProperty("hoverProvider");
    expect((result as any).capabilities).not.toHaveProperty("completionProvider");
  });

  it("sends requests and notifications over the JSON-RPC connection", async () => {
    const transport = createFakeServerTransport();
    await transport.connect({ processId: null, capabilities: {}, rootUri: null });
    const notification = new Promise<unknown>((resolve) => transport.onNotification("test/notify-ack", resolve));
    transport.sendNotification("test/notify", { hello: "world" });
    await expect(notification).resolves.toEqual({ hello: "world" });
    await expect(transport.sendRequest("test/echo", { message: "ping" })).resolves.toEqual({ message: "ping" });
  });

  it("gracefully shuts down with shutdown then exit", async () => {
    const transport = createFakeServerTransport();
    await transport.connect({ processId: null, capabilities: {}, rootUri: null });
    await expect(transport.dispose()).resolves.toBeUndefined();
    await expect(transport.exited).resolves.toBe(0);
  });

  it("captures bounded stderr for initialize failures", async () => {
    const transport = new StdioLspTransport({
      command: "bun",
      args: ["-e", "console.error('lsp stderr marker'); setTimeout(() => {}, 1000);"],
      captureStderr: true,
      stderrBufferLimit: 64,
      timeouts: { initializeMs: 50 },
    });
    transports.push(transport);
    await expect(transport.connect({ processId: null, capabilities: {}, rootUri: null })).rejects.toThrow("timed out");
    expect(transport.stderrSnapshot).toContain("lsp stderr marker");
  });
});
