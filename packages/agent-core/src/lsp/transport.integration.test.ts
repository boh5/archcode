import { afterAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { DEFAULT_FAKE_LSP_CONFIG } from "./fake-server";
import { StdioLspTransport } from "./transport";
import type {
  LspDeadlineHandle,
  LspDeadlineScheduler,
} from "./deadline-scheduler";

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

  it("fails initialization only when the controlled deadline fires", async () => {
    const deadline = createManualDeadlineScheduler();
    const transport = new StdioLspTransport({
      command: "bun",
      args: ["-e", "process.stdin.resume()"],
      timeouts: { initializeMs: 30_000 },
      deadlineScheduler: deadline.scheduler,
    });
    transports.push(transport);

    const connecting = transport.connect({ processId: null, capabilities: {}, rootUri: null });
    expect(deadline.scheduledDelays).toEqual([30_000]);
    deadline.fireNext();

    for (let turn = 0; turn < 10 && deadline.scheduledDelays.length < 2; turn += 1) {
      await Promise.resolve();
    }
    expect(deadline.scheduledDelays).toEqual([30_000, 2_000]);
    deadline.fireNext();

    await expect(connecting).rejects.toThrow("LSP initialize timed out after 30000ms");
    expect(deadline.scheduledDelays).toEqual([30_000, 2_000, 2_000]);
    expect(deadline.cancelled).toHaveLength(3);
  });

});

function createManualDeadlineScheduler(): {
  scheduler: LspDeadlineScheduler;
  fireNext: () => void;
  scheduledDelays: number[];
  cancelled: LspDeadlineHandle[];
} {
  const callbacks = new Map<number, () => void>();
  const scheduledDelays: number[] = [];
  const cancelled: LspDeadlineHandle[] = [];
  let nextId = 0;
  return {
    scheduler: {
      schedule(delayMs, callback) {
        const id = nextId++;
        scheduledDelays.push(delayMs);
        callbacks.set(id, callback);
        return { id };
      },
      cancel(handle) {
        cancelled.push(handle);
        if (typeof handle.id === "number") callbacks.delete(handle.id);
      },
      async sleep() {},
    },
    fireNext() {
      const entry = callbacks.entries().next().value as [number, () => void] | undefined;
      if (entry === undefined) throw new Error("No LSP deadline is scheduled");
      callbacks.delete(entry[0]);
      entry[1]();
    },
    scheduledDelays,
    cancelled,
  };
}
