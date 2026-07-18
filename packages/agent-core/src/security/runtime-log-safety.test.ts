import { afterEach, describe, expect, test } from "bun:test";
import type { Disposable } from "vscode-jsonrpc";
import { createInMemoryLogger, type LogEntry } from "../logger";
import { LspClient, LspError, setLspClientForTest } from "../lsp/client";
import { LspClientPool } from "../lsp/client-pool";
import { setInstallerProcessRunnerForTest } from "../lsp/installer";
import { setLspTransportForTest, type LspTransport } from "../lsp/transport";
import { SecretRedactionPolicy } from "./redaction";
import { createRuntimeLogSafetyBoundary } from "./runtime-log-safety";

const secret = "runtime-secret-literal-123456";
const workspaceRoot = "/private/tmp/archcode-runtime-log-workspace";

afterEach(() => {
  setLspClientForTest(undefined);
  setLspTransportForTest(undefined);
  setInstallerProcessRunnerForTest(undefined);
});

describe("Runtime log safety boundary", () => {
  test("redacts recursively through child loggers without retaining raw errors or stacks", () => {
    const { logger, entries } = createInMemoryLogger();
    const runtimeLogger = createRuntimeLogSafetyBoundary(logger, new SecretRedactionPolicy([secret]));
    const error = new Error(`failed at ${workspaceRoot} with ${secret}`);

    runtimeLogger.child({ module: "runtime.child", context: { workspaceRoot } }).error("runtime.child.failed", {
      context: { nested: [{ value: secret, path: workspaceRoot }] },
      error,
      meta: { url: `file://${workspaceRoot}/artifact`, headers: { authorization: secret } },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: "runtime.child.failed", module: "runtime.child" });
    expect(entries[0]?.meta).toMatchObject({
      error: { name: "Error", code: "RUNTIME_LOG_FAILURE" },
    });
    expect(entries[0]?.error).toBeUndefined();
    expectNoRuntimeRawValues(entries);
  });

  test("protects LspClient request and LspClientPool acquire failure logs", async () => {
    const { logger, entries } = createInMemoryLogger();
    const runtimeLogger = createRuntimeLogSafetyBoundary(logger, new SecretRedactionPolicy([secret]));
    const requestError = new LspError({
      code: -32001,
      message: `request ${secret} failed in ${workspaceRoot}/source.ts`,
    });
    const client = new LspClient({
      workspaceRoot,
      logger: runtimeLogger.child({ module: "runtime.lsp" }),
      transport: failingTransport(requestError),
      timeouts: { contentModifiedRetries: 0 },
    });

    await expect(client.sendRequest("textDocument/hover")).rejects.toBe(requestError);

    setInstallerProcessRunnerForTest(() => ({
      stdout: textStream("/fake/bin/gopls\n"),
      stderr: textStream(""),
      exited: Promise.resolve(0),
      exitCode: 0,
      signalCode: null,
      kill: () => {},
    }));
    setLspTransportForTest(() => Object.assign(
      failingTransport(new Error("unused")),
      { stderrSnapshot: `stderr ${secret} from ${workspaceRoot}/server.log` },
    ));
    setLspClientForTest(() => ({
      initialize: async () => {
        throw new Error(`initialize ${secret} in ${workspaceRoot}/.archcode/artifact`);
      },
      shutdown: async () => {},
    }) as unknown as LspClient);
    const pool = new LspClientPool({ logger: runtimeLogger.child({ module: "runtime.lsp" }) });

    await expect(pool.acquire({ workspaceRoot, serverId: "go" }, { command: "gopls" })).rejects.toThrow("initialize");

    const requestEntry = entries.find((entry) => entry.event === "lsp.client.request.failed");
    const acquireEntry = entries.find((entry) => entry.event === "lsp.pool.acquire.failed");
    expect(requestEntry).toMatchObject({ meta: { error: { name: "LspError", code: "-32001" } } });
    expect(acquireEntry).toMatchObject({
      context: { serverId: "go" },
      meta: { error: { name: "Error", code: "RUNTIME_LOG_FAILURE" }, lspStderrCaptured: true },
    });
    expectNoRuntimeRawValues(entries);
  });
});

function failingTransport(error: Error): LspTransport {
  return {
    connect: async () => ({ capabilities: {} }),
    sendRequest: async () => { throw error; },
    sendNotification: () => {},
    onNotification: (): Disposable => ({ dispose: () => {} }),
    dispose: async () => {},
  };
}

function expectNoRuntimeRawValues(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain(workspaceRoot);
}

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
