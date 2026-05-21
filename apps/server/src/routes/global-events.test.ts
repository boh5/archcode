import { describe, expect, mock, test } from "bun:test";
import type { SpecraRuntime } from "@specra/agent-core";
import type { GlobalSSEEvent } from "@specra/protocol";
import { Hono } from "hono";
import { createServerApp } from "../app";
import { errorHandler } from "../error-handler";
import { GlobalEventBus, globalEventBus, type GlobalEventBusListener } from "../events/global-event-bus";
import { createGlobalEventsRoutes } from "./global-events";

class CountingGlobalEventBus extends GlobalEventBus {
  listenerCount = 0;

  override subscribe(listener: GlobalEventBusListener): () => void {
    this.listenerCount += 1;
    const unsubscribe = super.subscribe(listener);
    return () => {
      this.listenerCount -= 1;
      unsubscribe();
    };
  }
}

function createApp(bus: GlobalEventBus, options?: Parameters<typeof createGlobalEventsRoutes>[1]): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/events", createGlobalEventsRoutes(bus, options));
  return app;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}

async function readUntil(response: Response, predicate: (text: string) => boolean): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected response body");

  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2000;

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Timed out reading SSE response")), remaining);
        }),
      ]);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
      if (predicate(text)) return text;
    }
  } finally {
    await reader.cancel();
  }

  throw new Error(`SSE predicate was not satisfied. Received: ${text}`);
}

function sessionEvent(input: { slug: string; sessionId: string; eventId: number; message: string }): GlobalSSEEvent {
  return {
    type: "event",
    slug: input.slug,
    sessionId: input.sessionId,
    eventId: input.eventId,
    createdAt: 123 + input.eventId,
    kind: "system-notice",
    payload: { type: "system-notice", message: input.message },
  };
}

describe("global events route", () => {
  test("inherits /api auth middleware when mounted in the server app", async () => {
    const { app } = createServerApp({} as SpecraRuntime, { dev: true, password: "secret" });

    const unauthorized = await app.request("/api/events");
    expect(unauthorized.status).toBe(401);

    const authorized = await app.request("/api/events", {
      headers: { Authorization: `Basic ${btoa("user:secret")}` },
    });
    expect(authorized.status).toBe(200);
    await authorized.body?.cancel();
  });

  test("sends heartbeat events on the configured interval", async () => {
    const bus = new GlobalEventBus();
    const response = await createApp(bus, { heartbeatIntervalMs: 10 }).request("/api/events");

    const text = await readUntil(response, (chunk) => chunk.includes("event: heartbeat"));
    expect(text).toContain('data: {"type":"heartbeat"');
  });

  test("forwards one session event with composite SSE id", async () => {
    const bus = new GlobalEventBus();
    const response = await createApp(bus).request("/api/events");

    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 7, message: "hello" }));

    const text = await readUntil(response, (chunk) => chunk.includes("hello"));
    expect(text).toContain("event: event");
    expect(text).toContain("id: alpha:s1:7");
    expect(text).toContain('data: {"type":"event","slug":"alpha","sessionId":"s1","eventId":7');
  });

  test("multiplexes events from two sessions on one connection", async () => {
    const bus = new GlobalEventBus();
    const response = await createApp(bus).request("/api/events");

    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 0, message: "one" }));
    bus.emit(sessionEvent({ slug: "beta", sessionId: "s2", eventId: 0, message: "two" }));

    const text = await readUntil(response, (chunk) => chunk.includes("two"));
    expect(text).toContain("id: alpha:s1:0");
    expect(text).toContain("id: beta:s2:0");
    expect(text.indexOf("one")).toBeLessThan(text.indexOf("two"));
  });

  test("emits lagged event when queued session events exceed the bounded queue", async () => {
    const bus = new GlobalEventBus();
    const firstWriteStarted = Promise.withResolvers<void>();
    const unblockWrites = Promise.withResolvers<void>();
    const onBeforeWrite = mock(async () => {
      firstWriteStarted.resolve();
      await unblockWrites.promise;
    });
    const response = await createApp(bus, { maxQueuedEvents: 2, onBeforeWrite }).request("/api/events");

    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 0, message: "kept-active" }));
    await firstWriteStarted.promise;
    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 1, message: "dropped-one" }));
    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 2, message: "kept-two" }));
    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 3, message: "kept-three" }));
    unblockWrites.resolve();

    const text = await readUntil(response, (chunk) => chunk.includes("kept-three"));
    expect(text).toContain("event: lagged");
    expect(text).toContain('data: {"type":"lagged","dropped":1,"reason":"client_backpressure"}');
    expect(text).not.toContain("dropped-one");
    expect(text).toContain("kept-two");
    expect(text).toContain("kept-three");
  });

  test("client disconnect cleans up the bus subscription", async () => {
    const bus = new CountingGlobalEventBus();
    const response = await createApp(bus).request("/api/events");
    expect(bus.listenerCount).toBe(1);

    await response.body?.cancel();
    await delay(10);

    expect(bus.listenerCount).toBe(0);
  });

  test("writes shutdown events without closing before the frame is sent", async () => {
    const bus = new GlobalEventBus();
    const response = await createApp(bus).request("/api/events");

    bus.emit({ type: "shutdown", reason: "server-stop" });

    const text = await readUntil(response, (chunk) => chunk.includes("event: shutdown"));
    expect(text).toContain('data: {"type":"shutdown","reason":"server-stop"}');
  });

  test("server app uses the shared global event bus singleton", async () => {
    const { app } = createServerApp({} as SpecraRuntime, { dev: true });
    const response = await app.request("/api/events");

    globalEventBus.emit(sessionEvent({ slug: "shared", sessionId: "singleton", eventId: 1, message: "from-singleton" }));

    const text = await readUntil(response, (chunk) => chunk.includes("from-singleton"));
    expect(text).toContain("id: shared:singleton:1");
  });
});
