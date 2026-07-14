import { describe, expect, test } from "bun:test";
import { LspClient, LspError, type LspClientOptions } from "./client";
import { FakeLspServer, type FakeLspServerConfig } from "./fake-server";

async function withServer(
  config: Partial<FakeLspServerConfig> | undefined,
  fn: (client: LspClient) => Promise<void>,
  clientOptions?: Partial<LspClientOptions>,
): Promise<void> {
  const server = new FakeLspServer(config);
  try {
    const transport = await server.start();
    const client = new LspClient({ transport, workspaceRoot: import.meta.dir, ...clientOptions });
    await fn(client);
  } finally {
    await server.stop();
  }
}

describe("LspClient integration", () => {
  test("sendRequest sends request and returns response", async () => {
    await withServer(undefined, async (client) => {
      await client.initialize(import.meta.dir);
      await expect(client.sendRequest("test/echo", { message: "ping" })).resolves.toEqual({ message: "ping" });
    });
  });

  test("sendNotification sends notification without waiting", async () => {
    await withServer(undefined, async (client) => {
      await client.initialize(import.meta.dir);
      const notification = new Promise<unknown>((resolve) => client.onNotification("test/notify-ack", resolve));
      client.sendNotification("test/notify", { hello: "world" });
      await expect(notification).resolves.toEqual({ hello: "world" });
    });
  });

  test("request timeout returns actionable LspError", async () => {
    await withServer({ delayMs: 100 }, async (client) => {
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
    }, { timeouts: { requestMs: 10 } });
  });

  test("onNotification registers handler and receives push notifications", async () => {
    await withServer({ autoDiagnostics: [{ message: "diagnostic", severity: 1 }] }, async (client) => {
      await client.initialize(import.meta.dir);
      const pushed = new Promise<unknown>((resolve) => client.onNotification("textDocument/publishDiagnostics", resolve));
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri: "file:///test.ts", languageId: "typescript", version: 1, text: "" },
      });
      await expect(pushed).resolves.toEqual({
        uri: "file:///test.ts",
        diagnostics: [{ message: "diagnostic", severity: 1 }],
      });
    });
  });
});
