import { afterAll, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  DEFAULT_LSP_TRANSPORT_TIMEOUTS,
  StdioLspTransport,
  adaptReader,
  adaptWriter,
  setLspTransportForTest,
  type LspTransport,
} from "./transport";

const transports: StdioLspTransport[] = [];

function createFakeServerTransport(): StdioLspTransport {
  const serverPath = path.join(import.meta.dir, "fake-server.ts");
  const transport = new StdioLspTransport({ command: "bun", args: ["run", serverPath] });
  transports.push(transport);
  return transport;
}

afterAll(async () => {
  await Promise.all(transports.map((transport) => transport.dispose()));
  setLspTransportForTest(undefined);
});

describe("RAL adapters", () => {
  it("adapts a Bun readable stream into vscode-jsonrpc RAL readable", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });

    const readable = adaptReader(stream);
    const received = await new Promise<Uint8Array>((resolve) => {
      readable.onData(resolve);
    });

    expect(received).toEqual(payload);
  });

  it("adapts a Bun file sink into vscode-jsonrpc RAL writable", async () => {
    const chunks: Uint8Array[] = [];
    let ended = false;
    const writable = adaptWriter({
      write(chunk: Uint8Array) {
        chunks.push(chunk);
      },
      end() {
        ended = true;
      },
    });

    await writable.write("hello");
    writable.end();

    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
    expect(ended).toBe(true);
  });
});

describe("StdioLspTransport", () => {
  it("exposes default timeout configuration", () => {
    expect(DEFAULT_LSP_TRANSPORT_TIMEOUTS).toEqual({
      initializeMs: 30_000,
      requestMs: 15_000,
      shutdownMs: 5_000,
    });
  });

  it("connects to the fake server and initializes", async () => {
    const transport = createFakeServerTransport();

    const result = await transport.connect({
      processId: null,
      capabilities: {},
      rootUri: null,
    });

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

    const notification = new Promise<unknown>((resolve) => {
      transport.onNotification("test/notify-ack", resolve);
    });

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

  it("supports replacing the transport constructor for tests", () => {
    class FakeTransport implements LspTransport {
      connect = async () => null;
      sendRequest = async () => null;
      sendNotification = () => {};
      onNotification = () => ({ dispose() {} });
      dispose = async () => {};
    }

    setLspTransportForTest(() => new FakeTransport());
    setLspTransportForTest(undefined);
  });
});
