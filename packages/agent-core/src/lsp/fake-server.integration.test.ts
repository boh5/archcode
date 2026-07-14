import { describe, expect, test, afterAll } from "bun:test";
import path from "node:path";
import { rm } from "node:fs/promises";
import { FakeLspServer, DEFAULT_INITIALIZE_RESULT } from "./fake-server";
import type { FakeLspServerConfig } from "./fake-server";
import { setLspTransportForTest, type LspTransport } from "./transport";

const TMP_DIR = path.join(import.meta.dir, "__test_tmp__", crypto.randomUUID());

afterAll(async () => {
  setLspTransportForTest(undefined);
  await rm(TMP_DIR, { recursive: true, force: true });
});

async function withServer(
  config: Partial<FakeLspServerConfig> | undefined,
  fn: (server: FakeLspServer, transport: LspTransport) => Promise<void>,
) {
  const server = new FakeLspServer(config);
  try {
    const transport = await server.start();
    await fn(server, transport);
  } finally {
    await server.stop();
  }
}

describe("FakeLspServer integration", () => {
  test("connects with default initialize result", async () => {
    await withServer(undefined, async (server) => {
      expect(server.initializeResult).toEqual(DEFAULT_INITIALIZE_RESULT);
    });
  });

  test("supports custom initialize result", async () => {
    const customInit = { custom: true, serverInfo: { name: "custom-server" } };
    await withServer({ initializeResult: customInit }, async (server) => {
      expect(server.initializeResult).toEqual(customInit);
    });
  });

  test("responds to configured textDocument/definition", async () => {
    const definitionResult = {
      uri: "file:///test.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    };

    await withServer(
      { responses: { "textDocument/definition": definitionResult } },
      async (_, transport) => {
        const result = await transport.sendRequest("textDocument/definition", {
          textDocument: { uri: "file:///test.ts" },
          position: { line: 0, character: 0 },
        });
        expect(result).toEqual(definitionResult);
      },
    );
  });

  test("responds to configured textDocument/references", async () => {
    const referencesResult = [
      {
        uri: "file:///test.ts",
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
      },
    ];

    await withServer(
      { responses: { "textDocument/references": referencesResult } },
      async (_, transport) => {
        const result = await transport.sendRequest("textDocument/references", {
          textDocument: { uri: "file:///test.ts" },
          position: { line: 0, character: 0 },
        });
        expect(result).toEqual(referencesResult);
      },
    );
  });

  test("responds to configured textDocument/documentSymbol", async () => {
    const symbolsResult = [
      {
        name: "foo",
        kind: 12,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 2, character: 0 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 2, character: 0 },
        },
      },
    ];

    await withServer(
      { responses: { "textDocument/documentSymbol": symbolsResult } },
      async (_, transport) => {
        const result = await transport.sendRequest("textDocument/documentSymbol", {
          textDocument: { uri: "file:///test.ts" },
        });
        expect(result).toEqual(symbolsResult);
      },
    );
  });

  test("responds to configured textDocument/hover", async () => {
    const hoverResult = { contents: "hover info" };

    await withServer(
      { responses: { "textDocument/hover": hoverResult } },
      async (_, transport) => {
        const result = await transport.sendRequest("textDocument/hover", {
          textDocument: { uri: "file:///test.ts" },
          position: { line: 0, character: 0 },
        });
        expect(result).toEqual(hoverResult);
      },
    );
  });

  test("responds to configured workspace/symbol", async () => {
    const symbolResult = [
      {
        name: "MySymbol",
        kind: 12,
        location: {
          uri: "file:///test.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        },
      },
    ];

    await withServer(
      { responses: { "workspace/symbol": symbolResult } },
      async (_, transport) => {
        const result = await transport.sendRequest("workspace/symbol", { query: "My" });
        expect(result).toEqual(symbolResult);
      },
    );
  });

  test("pushes diagnostics after didOpen", async () => {
    const diagnostics = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: "test error",
        severity: 1,
      },
    ];

    const server = new FakeLspServer({ autoDiagnostics: diagnostics });
    try {
      const transport = await server.start();

      const diagPromise = server.waitForNotification("textDocument/publishDiagnostics");
      transport.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: "file:///test.ts",
          languageId: "typescript",
          version: 1,
          text: "",
        },
      });

      const result: any = await diagPromise;
      expect(result.uri).toBe("file:///test.ts");
      expect(result.diagnostics).toEqual(diagnostics);
    } finally {
      await server.stop();
    }
  });

  test("does not push diagnostics when client omits publishDiagnostics capability", async () => {
    const server = new FakeLspServer({
      autoDiagnostics: [{ message: "hidden diagnostic", severity: 1 }],
      clientCapabilities: {},
    });
    try {
      const transport = await server.start();

      const diagPromise = server.waitForNotification("textDocument/publishDiagnostics", 100);
      transport.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: "file:///test.ts",
          languageId: "typescript",
          version: 1,
          text: "",
        },
      });

      await expect(diagPromise).rejects.toThrow("timed out");
    } finally {
      await server.stop();
    }
  });

  test("simulates response delay", async () => {
    const server = new FakeLspServer({ delayMs: 200 });
    try {
      const transport = await server.start();

      const start = Date.now();
      await transport.sendRequest("test/echo", {});
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(150);
    } finally {
      await server.stop();
    }
  });

  test("crash after initialize makes server exit", async () => {
    const server = new FakeLspServer({
      crashAfterInitialize: true,
      crashExitCode: 42,
    });
    try {
      await server.start();
      const exitCode = await Promise.race([
        server.exited!,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("exited timed out")), 3000),
        ),
      ]);
      expect(exitCode).toBe(42);
    } finally {
      await server.stop();
    }
  });

  test("crash after initialize with default exit code", async () => {
    const server = new FakeLspServer({ crashAfterInitialize: true });
    try {
      await server.start();
      const exitCode = await Promise.race([
        server.exited!,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("exited timed out")), 3000),
        ),
      ]);
      expect(exitCode).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("graceful shutdown", async () => {
    await withServer(undefined, async (server, transport) => {
      await transport.sendRequest("test/echo", { ok: true });
      await server.stop();
    });
  });

  test("returns error for unknown method", async () => {
    await withServer(undefined, async (_, transport) => {
      await expect(transport.sendRequest("unknown/method", {})).rejects.toThrow();
    });
  });

  test("supports built-in test/echo", async () => {
    await withServer(undefined, async (_, transport) => {
      const result = await transport.sendRequest("test/echo", { msg: "hello" });
      expect(result).toEqual({ msg: "hello" });
    });
  });

  test("supports built-in test/notify", async () => {
    const server = new FakeLspServer({});
    try {
      const transport = await server.start();

      const notifyPromise = server.waitForNotification("test/notify-ack");
      transport.sendNotification("test/notify", { key: "value" });
      await expect(notifyPromise).resolves.toEqual({ key: "value" });
    } finally {
      await server.stop();
    }
  });

  test("double start throws", async () => {
    const server = new FakeLspServer({});
    try {
      await server.start();
      await expect(server.start()).rejects.toThrow("already running");
    } finally {
      await server.stop();
    }
  });

  test("waitForNotification before start throws", () => {
    const server = new FakeLspServer({});
    expect(() => server.waitForNotification("test")).toThrow("not started");
  });

  test("initialize result is null before start", () => {
    const server = new FakeLspServer({});
    expect(server.initializeResult).toBeNull();
  });

  test("exited is undefined before start", () => {
    const server = new FakeLspServer({});
    expect(server.exited).toBeUndefined();
  });

  test("stop is safe to call before start", async () => {
    const server = new FakeLspServer({});
    await expect(server.stop()).resolves.toBeUndefined();
  });

  test("stop is safe to call multiple times", async () => {
    const server = new FakeLspServer({});
    try {
      await server.start();
      await server.stop();
      await server.stop();
    } finally {
      await server.stop();
    }
  });

  test("configured responses coexist with built-in test/echo", async () => {
    const defResult = {
      uri: "file:///a.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };

    await withServer(
      { responses: { "textDocument/definition": defResult } },
      async (_, transport) => {
        const def = await transport.sendRequest("textDocument/definition", {});
        expect(def).toEqual(defResult);

        const echo = await transport.sendRequest("test/echo", { ping: true });
        expect(echo).toEqual({ ping: true });
      },
    );
  });

  test("can start multiple independent fake servers", async () => {
    const s1 = new FakeLspServer({});
    const s2 = new FakeLspServer({});
    try {
      const t1 = await s1.start();
      const t2 = await s2.start();

      const r1 = await t1.sendRequest("test/echo", { id: 1 });
      const r2 = await t2.sendRequest("test/echo", { id: 2 });

      expect(r1).toEqual({ id: 1 });
      expect(r2).toEqual({ id: 2 });
      expect(s1.initializeResult).toEqual(DEFAULT_INITIALIZE_RESULT);
      expect(s2.initializeResult).toEqual(DEFAULT_INITIALIZE_RESULT);
    } finally {
      await s1.stop();
      await s2.stop();
    }
  });
});
