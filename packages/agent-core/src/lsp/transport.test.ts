import { describe, expect, it } from "bun:test";
import { ReadableStreamMessageReader } from "vscode-jsonrpc";
import {
  DEFAULT_LSP_TRANSPORT_TIMEOUTS,
  adaptReader,
  adaptWriter,
  setLspTransportForTest,
  type LspTransport,
} from "./transport";

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
