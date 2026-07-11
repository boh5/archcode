import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { connectSSE, HTTPStatusError } from "./sse-client";

type FetchMock = ReturnType<typeof mock<(...args: Parameters<typeof fetch>) => Promise<Response>>>;

const originalDocument = globalThis.document;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

interface ScheduledTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

let currentTime = 0;
let nextTimerId = 1;
let scheduledTimers: ScheduledTimer[] = [];

function installFakeTimers(): void {
  currentTime = 0;
  nextTimerId = 1;
  scheduledTimers = [];

  globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = nextTimerId++;
    scheduledTimers.push({
      id,
      dueAt: currentTime + delay,
      callback: typeof callback === "function" ? () => callback() : () => {},
    });
    return id;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((id?: number) => {
    if (id === undefined) return;
    scheduledTimers = scheduledTimers.filter((timer) => timer.id !== id);
  }) as typeof clearTimeout;
}

function restoreFakeTimers(): void {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  scheduledTimers = [];
}

function advanceTimers(ms: number): void {
  const targetTime = currentTime + ms;

  while (true) {
    scheduledTimers.sort((a, b) => a.dueAt - b.dueAt);
    const nextTimer = scheduledTimers[0];
    if (!nextTimer || nextTimer.dueAt > targetTime) break;

    scheduledTimers.shift();
    currentTime = nextTimer.dueAt;
    nextTimer.callback();
  }

  currentTime = targetTime;
}

function createChunkedSseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status },
  );
}

function createOpenSseResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("connectSSE", () => {
  beforeEach(() => {
    const dom = new JSDOM("", { url: "http://localhost" });
    globalThis.document = dom.window.document;
    installFakeTimers();
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    restoreFakeTimers();
  });

  test("parses a named SSE event split across chunk boundaries", async () => {
    const events: Array<{ event: string; data: string; id?: string }> = [];
    let client: ReturnType<typeof connectSSE> | undefined;
    const fetchMock: FetchMock = mock(async () => createChunkedSseResponse([
      "id: event-1\neve",
      "nt: stream\nda",
      "ta: {\"ok\":true}\n\n",
    ]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    client = connectSSE("/api/events", {
      onEvent: (event) => {
        events.push(event);
        client?.abort();
      },
    });
    await client.closed;

    expect(events).toEqual([{ event: "stream", data: '{"ok":true}', id: "event-1" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("reports connection open and loss so authoritative snapshots can be invalidated", async () => {
    const onConnectionOpen = mock(() => {});
    const onConnectionLost = mock(() => {});
    let client: ReturnType<typeof connectSSE> | undefined;
    const fetchMock: FetchMock = mock(async () => createChunkedSseResponse([
      "event: heartbeat\ndata: {\"type\":\"heartbeat\",\"createdAt\":1}\n\n",
    ]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    client = connectSSE("/api/events", {
      onEvent: () => {},
      onConnectionOpen,
      onConnectionLost: () => {
        onConnectionLost();
        client?.abort();
      },
    });
    await client.closed;

    expect(onConnectionOpen).toHaveBeenCalledTimes(1);
    expect(onConnectionLost).toHaveBeenCalledTimes(1);
  });

  test("reports a connection attempt before a fetch that only settles when aborted", async () => {
    const order: string[] = [];
    const onConnectionAttempt = mock(() => order.push("attempt"));
    const fetchMock: FetchMock = mock((_input, init) => new Promise<Response>((_resolve, reject) => {
      order.push("fetch");
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("Expected an AbortSignal");
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = connectSSE("/api/events", {
      onEvent: () => {},
      onConnectionAttempt,
    });
    await flushMicrotasks();

    expect(onConnectionAttempt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["attempt", "fetch"]);

    client.abort();
    await client.closed;
  });

  test("does not report a stale open when an aborted fetch resolves late", async () => {
    const pendingResponse = Promise.withResolvers<Response>();
    const onConnectionOpen = mock(() => {});
    const onEvent = mock(() => {});
    const fetchMock: FetchMock = mock(() => pendingResponse.promise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = connectSSE("/api/events", {
      onEvent,
      onConnectionOpen,
    });
    await flushMicrotasks();

    client.abort();
    pendingResponse.resolve(createChunkedSseResponse([
      "event: heartbeat\ndata: {\"type\":\"heartbeat\",\"createdAt\":1}\n\n",
    ]));
    await client.closed;

    expect(client.signal.aborted).toBe(true);
    expect(onConnectionOpen).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("sends Basic auth header from ARCHCODE_SERVER_PASSWORD cookie", async () => {
    document.cookie = "ARCHCODE_SERVER_PASSWORD=secret%20value";
    const fetchMock: FetchMock = mock(async () => createOpenSseResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = connectSSE("/api/events", { onEvent: () => {} });
    await flushMicrotasks();
    client.abort();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeInstanceOf(Headers);
    expect((init.headers as Headers).get("Authorization")).toBe(`Basic ${btoa(":secret value")}`);
  });

  test("aborts without leaving a reconnect timer pending", async () => {
    const fetchMock: FetchMock = mock(async () => new Response("unauthorized", { status: 401 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = connectSSE("/api/events", { onEvent: () => {}, onError: () => {} });
    await flushMicrotasks();

    expect(scheduledTimers).toHaveLength(1);
    client.abort();
    expect(scheduledTimers).toHaveLength(0);
  });

  test("resolves closed promptly when aborted during reconnect delay", async () => {
    const fetchMock: FetchMock = mock(async () => new Response("unauthorized", { status: 401 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = connectSSE("/api/events", { onEvent: () => {}, onError: () => {} });
    let closed = false;
    client.closed.then(() => {
      closed = true;
    });
    await flushMicrotasks();
    expect(scheduledTimers).toHaveLength(1);

    client.abort();
    await flushMicrotasks();

    expect(closed).toBe(true);
    expect(scheduledTimers).toHaveLength(0);
  });

  test("retries HTTP 401 and 500 responses with status metadata and exponential backoff", async () => {
    const errors: HTTPStatusError[] = [];
    const onConnectionAttempt = mock(() => {});
    const fetchMock: FetchMock = mock(async () => {
      const status = fetchMock.mock.calls.length === 1 ? 401 : 500;
      return new Response("failed", { status });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = connectSSE("/api/events", {
      onEvent: () => {},
      onError: (error) => {
        if (error instanceof HTTPStatusError) errors.push(error);
      },
      onConnectionAttempt,
    });

    await flushMicrotasks();
    expect(errors.map((error) => error.status)).toEqual([401]);
    expect(onConnectionAttempt).toHaveBeenCalledTimes(1);
    expect(scheduledTimers.map((timer) => timer.dueAt)).toEqual([1_000]);

    advanceTimers(1_000);
    await flushMicrotasks();
    expect(errors.map((error) => error.status)).toEqual([401, 500]);
    expect(onConnectionAttempt).toHaveBeenCalledTimes(2);
    expect(scheduledTimers.map((timer) => timer.dueAt)).toEqual([3_000]);

    client.abort();
  });
});
