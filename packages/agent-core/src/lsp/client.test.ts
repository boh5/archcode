import { afterEach, describe, expect, test } from "bun:test";
import type { Disposable } from "vscode-jsonrpc";
import { FakeLspServer, type FakeLspServerConfig } from "./fake-server";
import { LspClient, LspError, createLspClient, setLspClientForTest } from "./client";
import type { LspClientOptions } from "./client";
import type { LspTransport } from "./transport";

afterEach(() => {
  setLspClientForTest(undefined);
});

async function withServer(
  config: Partial<FakeLspServerConfig> | undefined,
  fn: (client: LspClient, server: FakeLspServer) => Promise<void>,
  clientOptions?: Partial<LspClientOptions>,
): Promise<void> {
  const server = new FakeLspServer(config);
  try {
    const transport = await server.start();
    const client = new LspClient({
      transport,
      workspaceRoot: import.meta.dir,
      ...clientOptions,
    });
    await fn(client, server);
  } finally {
    await server.stop();
  }
}

describe("LspClient", () => {
  test("initialize sends capabilities and receives server capabilities", async () => {
    const initializeResult = {
      capabilities: { hoverProvider: true, definitionProvider: true },
      serverInfo: { name: "client-test-server" },
    };
    const transport = new RecordingTransport({ connectResult: initializeResult });
    const client = new LspClient({ transport, workspaceRoot: "/workspace" });

    const capabilities = await client.initialize("/workspace", {
      capabilities: { textDocument: { hover: { dynamicRegistration: false } } },
    });

    expect(capabilities).toEqual(initializeResult.capabilities);
    expect(client.capabilities).toEqual(initializeResult.capabilities);
    expect(transport.connectParams).toEqual({
      processId: null,
      rootUri: "file:///workspace",
      capabilities: { textDocument: { hover: { dynamicRegistration: false } } },
    });
    expect(transport.notifications).toEqual([{ method: "initialized", params: {} }]);
  });

  test("shutdown sends shutdown, exit, then disposes transport", async () => {
    const transport = new RecordingTransport();
    const client = new LspClient({ transport, workspaceRoot: "/workspace" });

    await client.shutdown();

    expect(transport.events).toEqual([
      "request:shutdown",
      "notification:exit",
      "dispose",
    ]);
    expect(transport.disposed).toBe(true);
  });

  test("sendRequest sends request and returns response", async () => {
    await withServer(undefined, async (client) => {
      await client.initialize(import.meta.dir);

      const result = await client.sendRequest("test/echo", { message: "ping" });

      expect(result).toEqual({ message: "ping" });
    });
  });

  test("sendNotification sends notification without waiting", async () => {
    await withServer(undefined, async (client) => {
      await client.initialize(import.meta.dir);
      const notification = new Promise<unknown>((resolve) => {
        client.onNotification("test/notify-ack", resolve);
      });

      client.sendNotification("test/notify", { hello: "world" });

      const result = await notification;

      expect(result).toEqual({ hello: "world" });
    });
  });

  test("contentModified error triggers three retries with exponential backoff", async () => {
    const transport = new RecordingTransport({
      requestHandler(method) {
        if (method === "textDocument/definition" && transport.requestCount <= 3) {
          throw jsonRpcError(-32801, "Content modified");
        }
        return { uri: "file:///workspace/test.ts" };
      },
    });
    const client = new LspClient({
      transport,
      workspaceRoot: "/workspace",
      timeouts: { contentModifiedBaseDelayMs: 1 },
    });

    const result = await client.sendRequest("textDocument/definition", {});

    expect(result).toEqual({ uri: "file:///workspace/test.ts" });
    expect(transport.requestCount).toBe(4);
    expect(transport.requestMethods).toEqual([
      "textDocument/definition",
      "textDocument/definition",
      "textDocument/definition",
      "textDocument/definition",
    ]);
  });

  test("contentModified final failure throws LspError with lsp-error kind", async () => {
    const transport = new RecordingTransport({
      requestHandler() {
        throw jsonRpcError(-32801, "Content modified");
      },
    });
    const client = new LspClient({
      transport,
      workspaceRoot: "/workspace",
      timeouts: { contentModifiedBaseDelayMs: 1 },
    });

    try {
      await client.sendRequest("textDocument/references", {});
      throw new Error("Expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LspError);
      expect((error as LspError).name).toBe("LspError");
      expect((error as LspError).kind).toBe("lsp-error");
      expect((error as LspError).code).toBe(-32801);
      expect((error as Error).message).toContain("document content changed");
    }
    expect(transport.requestCount).toBe(4);
  });

  test("request timeout returns actionable LspError", async () => {
    await withServer(
      { delayMs: 100 },
      async (client) => {
        try {
          await client.sendRequest("test/echo", { slow: true });
          throw new Error("Expected request to time out");
        } catch (error) {
          expect(error).toBeInstanceOf(LspError);
          expect((error as LspError).name).toBe("LspError");
          expect((error as LspError).kind).toBe("lsp-timeout");
          expect((error as Error).message).toContain("timed out");
          expect((error as Error).message).toContain("language server is responsive");
        }
      },
      { timeouts: { requestMs: 10 } },
    );
  });

  test("setLspClientForTest mock injection works", () => {
    const transport = new RecordingTransport();
    const injected = new LspClient({ transport, workspaceRoot: "/workspace" });
    setLspClientForTest(() => injected);

    const client = createLspClient({ transport, workspaceRoot: "/other" });

    expect(client).toBe(injected);
  });

  test("onNotification registers handler and receives push notifications", async () => {
    await withServer({ autoDiagnostics: [{ message: "diagnostic", severity: 1 }] }, async (client) => {
      await client.initialize(import.meta.dir);
      const pushed = new Promise<unknown>((resolve) => {
        client.onNotification("textDocument/publishDiagnostics", resolve);
      });

      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: "file:///test.ts",
          languageId: "typescript",
          version: 1,
          text: "",
        },
      });

      const result = await pushed;

      expect(result).toEqual({
        uri: "file:///test.ts",
        diagnostics: [{ message: "diagnostic", severity: 1 }],
      });
    });
  });
});

class RecordingTransport implements LspTransport {
  readonly events: string[] = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly requestMethods: string[] = [];
  connectParams: unknown;
  disposed = false;
  requestCount = 0;

  private readonly connectResult: unknown;
  private readonly requestHandler?: (method: string, params: unknown) => unknown | Promise<unknown>;
  private readonly notificationHandlers = new Map<string, Array<(params: unknown) => void>>();

  constructor(options: { connectResult?: unknown; requestHandler?: (method: string, params: unknown) => unknown | Promise<unknown> } = {}) {
    this.connectResult = options.connectResult ?? { capabilities: {} };
    this.requestHandler = options.requestHandler;
  }

  async connect(params?: unknown): Promise<unknown> {
    this.connectParams = params;
    return this.connectResult;
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    this.events.push(`request:${method}`);
    this.requestMethods.push(method);
    this.requestCount += 1;
    if (this.requestHandler) return await this.requestHandler(method, params);
    return null;
  }

  sendNotification(method: string, params?: unknown): void {
    this.events.push(`notification:${method}`);
    this.notifications.push({ method, params });
    this.notificationHandlers.get(method)?.forEach((handler) => handler(params));
  }

  onNotification(method: string, handler: (params: unknown) => void): Disposable {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
    return {
      dispose: () => {
        const current = this.notificationHandlers.get(method) ?? [];
        this.notificationHandlers.set(method, current.filter((item) => item !== handler));
      },
    };
  }

  async dispose(): Promise<void> {
    this.events.push("dispose");
    this.disposed = true;
  }
}

function jsonRpcError(code: number, message: string): Error & { code: number; data?: unknown } {
  const error = new Error(message) as Error & { code: number; data?: unknown };
  error.code = code;
  return error;
}
