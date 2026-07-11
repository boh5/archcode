import { describe, it, expect, afterAll } from "bun:test";
import path from "node:path";
import type { Disposable } from "vscode-jsonrpc";
import {
  ReadableStreamMessageReader,
  WriteableStreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc";
import { DEFAULT_FAKE_LSP_CONFIG } from "./fake-server";

function adaptReader(stream: ReadableStream<Uint8Array>): RALReadable {
  const r = stream.getReader();
  return {
    onData(listener: (data: Uint8Array) => void): Disposable {
      let cancelled = false;
      const pump = () => {
        if (cancelled) return;
        r.read().then(({ done, value }) => {
          if (cancelled || done) return;
          if (value) listener(value);
          pump();
        });
      };
      pump();
      return { dispose: () => { cancelled = true; r.cancel(); } };
    },
    onClose: () => ({ dispose: () => {} }),
    onError: () => ({ dispose: () => {} }),
    onEnd: () => ({ dispose: () => {} }),
  };
}

function adaptWriter(sink: { write(chunk: Uint8Array): void; end(): void }): RALWritable {
  const enc = new TextEncoder();
  return {
    async write(data: Uint8Array | string): Promise<void> {
      sink.write(typeof data === "string" ? enc.encode(data) : data);
    },
    end() { sink.end(); },
    onClose: () => ({ dispose: () => {} }),
    onError: () => ({ dispose: () => {} }),
    onEnd: () => ({ dispose: () => {} }),
  };
}

interface RALReadable {
  onData(listener: (data: Uint8Array) => void): Disposable;
  onClose(listener: () => void): Disposable;
  onError(listener: (error: any) => void): Disposable;
  onEnd(listener: () => void): Disposable;
}

interface RALWritable {
  write(data: Uint8Array | string, encoding?: string): Promise<void>;
  end(): void;
  onClose(listener: () => void): Disposable;
  onError(listener: (error: any) => void): Disposable;
  onEnd(listener: () => void): Disposable;
}

let child: ReturnType<typeof Bun.spawn> | undefined;
let connection: ReturnType<typeof createMessageConnection> | undefined;

afterAll(() => {
  if (connection) {
    try { connection.end(); } catch {}
  }
  if (child && child.exitCode === null) {
    child.kill();
    child = undefined;
  }
});

describe("vscode-jsonrpc compatibility spike", () => {
  it("can spawn fake server, send initialize, and receive response", async () => {
    const serverPath = path.join(import.meta.dir, "fake-server.ts");
    child = Bun.spawn(["bun", "run", serverPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, FAKE_LSP_CONFIG: JSON.stringify(DEFAULT_FAKE_LSP_CONFIG) },
    });

    const outStream = child.stdout as ReadableStream<Uint8Array>;
    const inSink = child.stdin as any;
    const reader = new ReadableStreamMessageReader(adaptReader(outStream));
    const writer = new WriteableStreamMessageWriter(adaptWriter(inSink));
    connection = createMessageConnection(reader, writer);
    connection.listen();

    const result: any = await connection.sendRequest("initialize", {
      processId: null,
      capabilities: {},
      rootUri: null,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("capabilities");
    expect(result).toHaveProperty("serverInfo");
    expect(result.serverInfo).toEqual({
      name: "fake-lsp-server",
      version: "0.0.1",
    });
    expect(result.capabilities).toHaveProperty("textDocumentSync", 1);
    expect(result.capabilities).toHaveProperty("definitionProvider", true);
    expect(result.capabilities).not.toHaveProperty("hoverProvider");
    expect(result.capabilities).not.toHaveProperty("completionProvider");
  });

  it("can send a notification", async () => {
    expect(connection).toBeDefined();

    const notifyReceived = new Promise<void>((resolve) => {
      connection!.onNotification("test/notify-ack", () => resolve());
    });

    connection!.sendNotification("test/notify", { hello: "world" });

    await expect(notifyReceived).resolves.toBeUndefined();
  });

  it("can send a custom request and receive response", async () => {
    expect(connection).toBeDefined();

    const result: any = await connection!.sendRequest("test/echo", {
      message: "ping",
    });

    expect(result).toEqual({ message: "ping" });
  });

  it("can send shutdown and properly end", async () => {
    expect(connection).toBeDefined();
    expect(child).toBeDefined();

    const shutdownResult: any = await connection!.sendRequest("shutdown", null);
    expect(shutdownResult).toBeNull();

    const exited = child!.exited;

    connection!.sendNotification("exit");
    connection!.end();
    connection = undefined;

    await exited;
    child = undefined;
  });
});
