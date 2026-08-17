import { describe, expect, mock, test } from "bun:test";
import type { GlobalSSEEvent, HitlView } from "@archcode/protocol";
import { Hono } from "hono";
import { errorHandler } from "../error-handler";
import { GlobalEventBus, type GlobalEventBusListener } from "../events/global-event-bus";
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

async function createFiniteResponse(
  bus: GlobalEventBus,
  stopAfter: (event: GlobalSSEEvent) => boolean,
  options: Parameters<typeof createGlobalEventsRoutes>[1] = {},
): Promise<Response> {
  const stream = new AbortController();
  return await createApp(bus, {
    ...options,
    streamLease: () => ({ signal: stream.signal, release: () => undefined }),
    onAfterWrite: async (event) => {
      await options.onAfterWrite?.(event);
      if (stopAfter(event)) stream.abort();
    },
  }).request("/api/events");
}

async function readFinite(response: Response): Promise<string> {
  return await response.text();
}

function sessionEvent(input: { slug: string; sessionId: string; eventId: number; message: string }): GlobalSSEEvent {
  return {
    type: "event",
    slug: input.slug,
    sessionId: input.sessionId,
    eventId: input.eventId,
    createdAt: 123 + input.eventId,
    payload: { type: "system-notice", message: input.message },
    agentName: "lead",
  };
}

function hitlProjection(hitlId: string): HitlView {
  return {
    hitlId,
    owner: { type: "session", id: "session-1" },
    source: { type: "ask_user", toolCallId: "call-1" },
    status: "pending",
    displayPayload: {
      title: "Need input",
      questions: [{ header: "Q1", question: "Continue?", options: [], custom: true }],
      redacted: true,
    },
    allowedActions: ["answer", "cancel"],
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

function hitlSnapshot(
  views: HitlView[] = [],
  projectSlugs: string[] = ["proj"],
): Extract<GlobalSSEEvent, { type: "hitl.snapshot" }> {
  return {
    type: "hitl.snapshot",
    projectSlugs,
    entries: views.map((view) => ({
      projectSlug: "proj",
      hitlId: view.hitlId,
      ownerSessionId: view.owner.id,
      rootSessionId: "root-1",
      ownerAgentName: "build",
      ownerSessionTitle: "Worker Session",
      view,
    })),
    createdAt: 0,
  };
}

function sessionRuntimeSnapshot(): Extract<GlobalSSEEvent, { type: "session.runtime.snapshot" }> {
  return {
    type: "session.runtime.snapshot",
    projectSlugs: ["proj"],
    families: [{ projectSlug: "proj", rootSessionId: "root-1", activity: "running" }],
    createdAt: 2,
  };
}

function sessionRuntimeChange(rootSessionId: string, activity: "idle" | "running" | "stopping"): GlobalSSEEvent {
  return {
    type: "session.runtime_changed",
    projectSlug: "proj",
    rootSessionId,
    activity,
    createdAt: Date.now(),
  };
}

describe("global events route", () => {
  test("closes the stream and unsubscribes when its auth session is revoked", async () => {
    const bus = new CountingGlobalEventBus();
    const revoked = new AbortController();
    const release = mock(() => undefined);
    const response = await createApp(bus, {
      streamLease: () => ({ signal: revoked.signal, release }),
    }).request("/api/events");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected response body");
    expect(bus.listenerCount).toBe(1);

    revoked.abort();
    const result = await reader.read();

    expect(result.done).toBe(true);
    expect(bus.listenerCount).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("forwards one session event with composite SSE id", async () => {
    const bus = new GlobalEventBus();
    const response = await createFiniteResponse(
      bus,
      (event) => event.type === "event" && event.payload.type === "system-notice"
        && event.payload.message === "hello",
    );

    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 7, message: "hello" }));

    const text = await readFinite(response);
    expect(text).toContain("event: event");
    expect(text).toContain("id: alpha:s1:7");
    expect(text).toContain('data: {"type":"event","slug":"alpha","sessionId":"s1","eventId":7');
  });

  test("writes one atomic pending HITL snapshot when a client connects", async () => {
    const bus = new GlobalEventBus();
    const response = await createFiniteResponse(
      bus,
      (event) => event.type === "hitl.snapshot",
      { initialEvents: async () => [hitlSnapshot([hitlProjection("hitl-refresh")])] },
    );

    const text = await readFinite(response);

    expect(text).toContain("event: hitl.snapshot");
    expect(text).toContain('\"entries\":[');
    expect(text).toContain('\"projectSlug\":\"proj\"');
    expect(text).toContain('\"hitlId\":\"hitl-refresh\"');
  });

  test("writes the authoritative Session Family runtime snapshot on connect", async () => {
    const bus = new GlobalEventBus();
    const response = await createFiniteResponse(
      bus,
      (event) => event.type === "session.runtime.snapshot",
      { initialEvents: () => [sessionRuntimeSnapshot()] },
    );

    const text = await readFinite(response);

    expect(text).toContain("event: session.runtime.snapshot");
    expect(text).toContain('"projectSlugs":["proj"]');
    expect(text).toContain('"families":[{"projectSlug":"proj","rootSessionId":"root-1","activity":"running"}]');
  });

  test("continues streaming live events after initial HITL snapshots", async () => {
    const bus = new GlobalEventBus();
    const response = await createFiniteResponse(
      bus,
      (event) => event.type === "event" && event.payload.type === "system-notice"
        && event.payload.message === "after-initial",
      { initialEvents: () => [hitlSnapshot([hitlProjection("hitl-initial")])] },
    );

    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 9, message: "after-initial" }));

    const text = await readFinite(response);
    expect(text.indexOf("hitl-initial")).toBeLessThan(text.indexOf("after-initial"));
    expect(text).toContain("id: alpha:s1:9");
  });

  test("buffers live events until delayed initial HITL snapshots are written", async () => {
    const bus = new GlobalEventBus();
    const initialStarted = Promise.withResolvers<void>();
    const releaseInitial = Promise.withResolvers<void>();
    const response = await createFiniteResponse(bus, (event) => (
      event.type === "event"
      && event.payload.type === "system-notice"
      && event.payload.message === "after-buffered-initial"
    ), {
      initialEvents: async () => {
        initialStarted.resolve();
        await releaseInitial.promise;
        return [hitlSnapshot([hitlProjection("hitl-buffered-initial")])];
      },
    });

    const textPromise = readFinite(response);
    await initialStarted.promise;
    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 10, message: "after-buffered-initial" }));
    releaseInitial.resolve();

    const text = await textPromise;
    expect(text.indexOf("hitl-buffered-initial")).toBeLessThan(text.indexOf("after-buffered-initial"));
  });

  test("multiplexes events from two sessions on one connection", async () => {
    const bus = new GlobalEventBus();
    const response = await createFiniteResponse(
      bus,
      (event) => event.type === "event" && event.payload.type === "system-notice"
        && event.payload.message === "two",
    );

    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 0, message: "one" }));
    bus.emit(sessionEvent({ slug: "beta", sessionId: "s2", eventId: 0, message: "two" }));

    const text = await readFinite(response);
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
    const response = await createFiniteResponse(
      bus,
      (event) => event.type === "event" && event.payload.type === "system-notice"
        && event.payload.message === "kept-three",
      { maxQueuedEvents: 2, onBeforeWrite },
    );

    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 0, message: "kept-active" }));
    await firstWriteStarted.promise;
    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 1, message: "dropped-one" }));
    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 2, message: "kept-two" }));
    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 3, message: "kept-three" }));
    unblockWrites.resolve();

    const text = await readFinite(response);
    expect(text).toContain("event: lagged");
    expect(text).toContain('data: {"type":"lagged","dropped":1,"reason":"client_backpressure"}');
    expect(text).not.toContain("dropped-one");
    expect(text).toContain("kept-two");
    expect(text).toContain("kept-three");
  });

  test("emits lagged when Session Family runtime changes are dropped", async () => {
    const bus = new GlobalEventBus();
    const firstWriteStarted = Promise.withResolvers<void>();
    const unblockWrites = Promise.withResolvers<void>();
    const onBeforeWrite = mock(async () => {
      firstWriteStarted.resolve();
      await unblockWrites.promise;
    });
    const response = await createFiniteResponse(
      bus,
      (event) => event.type === "session.runtime_changed"
        && event.rootSessionId === "kept-runtime-2",
      { maxQueuedEvents: 2, onBeforeWrite },
    );

    bus.emit(sessionRuntimeChange("active-write", "running"));
    await firstWriteStarted.promise;
    bus.emit(sessionRuntimeChange("dropped-runtime", "running"));
    bus.emit(sessionRuntimeChange("kept-runtime-1", "stopping"));
    bus.emit(sessionRuntimeChange("kept-runtime-2", "idle"));
    unblockWrites.resolve();

    const text = await readFinite(response);
    expect(text).toContain("event: lagged");
    expect(text).not.toContain("dropped-runtime");
    expect(text).toContain("kept-runtime-1");
    expect(text).toContain("kept-runtime-2");
  });

  test("writes shutdown events without closing before the frame is sent", async () => {
    const bus = new GlobalEventBus();
    const response = await createFiniteResponse(bus, (event) => event.type === "shutdown");

    bus.emit({ type: "shutdown", reason: "server-stop" });

    const text = await readFinite(response);
    expect(text).toContain('data: {"type":"shutdown","reason":"server-stop"}');
  });

});
