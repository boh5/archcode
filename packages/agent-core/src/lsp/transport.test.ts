import { afterAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { ReadableStreamMessageReader } from "vscode-jsonrpc";
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
    const payload = encodeFrame({ jsonrpc: "2.0", method: "test/payload" });
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

  it("splits multiple LSP frames from one Bun stream chunk", async () => {
    const chunk = concatBytes(
      encodeFrame({ jsonrpc: "2.0", method: "test/first", params: { value: 1 } }),
      encodeFrame({ jsonrpc: "2.0", method: "test/second", params: { value: 2 } }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const reader = new ReadableStreamMessageReader(adaptReader(stream));
    const received: unknown[] = [];
    reader.listen((message) => received.push(message));

    await waitFor(() => received.length === 2);
    expect(received).toEqual([
      { jsonrpc: "2.0", method: "test/first", params: { value: 1 } },
      { jsonrpc: "2.0", method: "test/second", params: { value: 2 } },
    ]);
  });

  it("buffers one LSP frame split across Bun stream chunks", async () => {
    const frame = encodeFrame({ jsonrpc: "2.0", method: "test/split", params: { value: true } });
    const splitAt = 12;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame.slice(0, splitAt));
        controller.enqueue(frame.slice(splitAt));
        controller.close();
      },
    });

    const reader = new ReadableStreamMessageReader(adaptReader(stream));
    const received: unknown[] = [];
    reader.listen((message) => received.push(message));

    await waitFor(() => received.length === 1);
    expect(received).toEqual([{ jsonrpc: "2.0", method: "test/split", params: { value: true } }]);
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

const encoder = new TextEncoder();

function encodeFrame(message: unknown): Uint8Array {
  const json = JSON.stringify(message);
  const body = encoder.encode(json);
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  return concatBytes(header, body);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

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
