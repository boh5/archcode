import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime } from "@archcode/agent-core";
import type { CompressionBlockCommittedEvent, GlobalSSEEvent, HitlView } from "@archcode/protocol";
import { Hono } from "hono";
import { createServerApp, createServerEventRuntime } from "../app";
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

function createGlobalServerRuntime(): AgentRuntime {
  return {
    listSessionRuntimeEvents: mock(async () => [{
      type: "session.runtime.snapshot",
      projectSlugs: [],
      families: [],
      createdAt: 0,
    }]),
    listHitlSnapshotEvents: mock(async () => []),
    subscribeSessionRuntimeChanges: mock(() => () => undefined),
  } as unknown as AgentRuntime;
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
    payload: { type: "system-notice", message: input.message },
    agentName: "engineer",
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
  return { type: "hitl.snapshot", projectSlugs, entries: views.map((view) => ({ projectSlug: "proj", view })), createdAt: 0 };
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
  test("inherits /api auth middleware when mounted in the server app", async () => {
    const { app } = createServerApp(createGlobalServerRuntime(), { dev: true, password: "secret" });

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

  test("writes one atomic pending HITL snapshot when a client connects", async () => {
    const bus = new GlobalEventBus();
    const response = await createApp(bus, { initialEvents: async () => [hitlSnapshot([hitlProjection("hitl-refresh")])] }).request("/api/events");

    const text = await readUntil(response, (chunk) => chunk.includes("hitl-refresh"));

    expect(text).toContain("event: hitl.snapshot");
    expect(text).not.toContain("event: hitl.event");
    expect(text).toContain('\"entries\":[');
    expect(text).toContain('\"projectSlug\":\"proj\"');
    expect(text).toContain('\"hitlId\":\"hitl-refresh\"');
  });

  test("writes the authoritative Session Family runtime snapshot on connect", async () => {
    const bus = new GlobalEventBus();
    const response = await createApp(bus, { initialEvents: () => [sessionRuntimeSnapshot()] }).request("/api/events");

    const text = await readUntil(response, (chunk) => chunk.includes("session.runtime.snapshot"));

    expect(text).toContain("event: session.runtime.snapshot");
    expect(text).toContain('"projectSlugs":["proj"]');
    expect(text).toContain('"families":[{"projectSlug":"proj","rootSessionId":"root-1","activity":"running"}]');
  });

  test("continues streaming live events after initial HITL snapshots", async () => {
    const bus = new GlobalEventBus();
    const response = await createApp(bus, { initialEvents: () => [hitlSnapshot([hitlProjection("hitl-initial")])] }).request("/api/events");

    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 9, message: "after-initial" }));

    const text = await readUntil(response, (chunk) => chunk.includes("after-initial"));
    expect(text.indexOf("hitl-initial")).toBeLessThan(text.indexOf("after-initial"));
    expect(text).toContain("id: alpha:s1:9");
  });

  test("buffers live events until delayed initial HITL snapshots are written", async () => {
    const bus = new GlobalEventBus();
    const initialStarted = Promise.withResolvers<void>();
    const releaseInitial = Promise.withResolvers<void>();
    const response = await createApp(bus, {
      initialEvents: async () => {
        initialStarted.resolve();
        await releaseInitial.promise;
        return [hitlSnapshot([hitlProjection("hitl-buffered-initial")])];
      },
    }).request("/api/events");

    const textPromise = readUntil(response, (chunk) => chunk.includes("after-buffered-initial"));
    await initialStarted.promise;
    bus.emit(sessionEvent({ slug: "alpha", sessionId: "s1", eventId: 10, message: "after-buffered-initial" }));
    releaseInitial.resolve();

    const text = await textPromise;
    expect(text.indexOf("hitl-buffered-initial")).toBeLessThan(text.indexOf("after-buffered-initial"));
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

  test("emits lagged when Session Family runtime changes are dropped", async () => {
    const bus = new GlobalEventBus();
    const firstWriteStarted = Promise.withResolvers<void>();
    const unblockWrites = Promise.withResolvers<void>();
    const onBeforeWrite = mock(async () => {
      firstWriteStarted.resolve();
      await unblockWrites.promise;
    });
    const response = await createApp(bus, { maxQueuedEvents: 2, onBeforeWrite }).request("/api/events");

    bus.emit(sessionRuntimeChange("active-write", "running"));
    await firstWriteStarted.promise;
    bus.emit(sessionRuntimeChange("dropped-runtime", "running"));
    bus.emit(sessionRuntimeChange("kept-runtime-1", "stopping"));
    bus.emit(sessionRuntimeChange("kept-runtime-2", "idle"));
    unblockWrites.resolve();

    const text = await readUntil(response, (chunk) => chunk.includes("kept-runtime-2"));
    expect(text).toContain("event: lagged");
    expect(text).not.toContain("dropped-runtime");
    expect(text).toContain("kept-runtime-1");
    expect(text).toContain("kept-runtime-2");
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
    const { app } = createServerApp(createGlobalServerRuntime(), { dev: true });
    const response = await app.request("/api/events");

    globalEventBus.emit(sessionEvent({ slug: "shared", sessionId: "singleton", eventId: 1, message: "from-singleton" }));

    const text = await readUntil(response, (chunk) => chunk.includes("from-singleton"));
    expect(text).toContain("id: shared:singleton:1");
  });

  test("bridges compression block commits through existing global SSE consumers", async () => {
    const runtime = createRuntimeWithManualSubscriptions();
    const serverRuntime = createServerEventRuntime(runtime);
    const response = await createApp(globalEventBus).request("/api/events");

    const execution = await serverRuntime.startSessionMessageExecution({
      slug: "proj",
      workspaceRoot: "/workspace",
      sessionId: "session-1",
      userMessage: "compress context",
    });
    runtime.emitSession("session-1", {
      type: "event",
      slug: "proj",
      sessionId: "session-1",
      eventId: 12,
      createdAt: 1700000000001,
      payload: compressionBlockCommittedEvent(),
      agentName: "engineer",
    });

    const text = await readUntil(response, (chunk) => chunk.includes("compression.block_committed"));
    expect(text).toContain("event: event");
    expect(text).toContain("id: proj:session-1:12");
    expect(text).toContain('"block":{"id":"block-1","ref":"b1"');
    expect(text).not.toContain("original messages");

    runtime.resolveExecution();
    await execution.promise;
  });

  test("server app no longer registers the old per-session SSE endpoint", async () => {
    const { app } = createServerApp(createGlobalServerRuntime(), { dev: true });

    const response = await app.request("/api/projects/project/sessions/session/events");

    expect(response.status).toBe(404);
  });
});

function createRuntimeWithManualSubscriptions() {
  const subscriptions = new Map<string, (event: GlobalSSEEvent) => void>();
  let resolveExecution!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveExecution = resolve;
  });

  const runtime = {
    subscribeSessionEvents: mock((input: { sessionId: string; onEvent: (event: GlobalSSEEvent) => void }) => {
      subscriptions.set(input.sessionId, input.onEvent);
      return () => subscriptions.delete(input.sessionId);
    }),
    startSessionMessageExecution: mock(async (input: {
      sessionId: string;
      workspaceRoot: string;
      executionId?: string;
    }) => ({
      sessionId: input.sessionId,
      rootSessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      agentName: "engineer" as const,
      origin: "user_message" as const,
      abortController: new AbortController(),
      promise,
      executionToken: Symbol("global-events-test-execution"),
      startedAt: Date.now(),
      executionId: input.executionId ?? "execution-1",
    })),
    emitSession: (sessionId: string, event: GlobalSSEEvent) => subscriptions.get(sessionId)?.(event),
    resolveExecution: () => resolveExecution(),
  };

  return runtime as unknown as AgentRuntime & {
    emitSession: (sessionId: string, event: GlobalSSEEvent) => void;
    resolveExecution: () => void;
  };
}

function compressionBlockCommittedEvent(): CompressionBlockCommittedEvent {
  return {
    type: "compression.block_committed",
    block: {
      id: "block-1",
      ref: "b1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "model_tool_call",
      range: {
        startMessageId: "msg-1",
        endMessageId: "msg-2",
        startRef: "m0001",
        endRef: "m0002",
        startIndex: 0,
        endIndex: 1,
      },
      summary: "compressed summary",
      childBlockRefs: [],
      protectedRefs: [],
      createdAt: 100,
      updatedAt: 100,
    },
  };
}
