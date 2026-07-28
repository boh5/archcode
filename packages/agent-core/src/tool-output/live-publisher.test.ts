import { describe, expect, test } from "bun:test";
import { MAX_EVENTS, type ToolOutputDeltaEvent } from "@archcode/protocol";

import { createMockStore } from "../store/test-helpers";
import {
  LiveToolOutputPublisher,
  type LiveToolOutputPublisherOptions,
} from "./live-publisher";

class ManualTimer {
  #nextId = 1;
  readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = this.#nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(Number(handle));
  }

  runAll(): void {
    for (const [id, callback] of [...this.callbacks]) {
      this.callbacks.delete(id);
      callback();
    }
  }
}

const encoder = new TextEncoder();

function deltaEvents(
  store: ReturnType<typeof createMockStore>,
): ToolOutputDeltaEvent[] {
  return store.getState().events.flatMap((event) =>
    event.payload.type === "tool-output-delta" ? [event.payload] : []
  );
}

function createPublisher(
  overrides: Partial<LiveToolOutputPublisherOptions> = {},
) {
  const store = overrides.store ?? createMockStore();
  const timer = overrides.timer ?? new ManualTimer();
  const publisher = new LiveToolOutputPublisher({
    store,
    toolCallId: overrides.toolCallId ?? "call-1",
    timer,
    intervalMs: overrides.intervalMs ?? 100,
    eventMaxBytes: overrides.eventMaxBytes ?? 4 * 1024,
    eventMaxCount: overrides.eventMaxCount ?? 10_000,
  });
  return { store, timer: timer as ManualTimer, publisher };
}

describe("LiveToolOutputPublisher", () => {
  test("coalesces one timer window and flushes pending canonical output", () => {
    const { store, timer, publisher } = createPublisher();

    publisher.pushCanonical(encoder.encode("STDOUT:\n"));
    publisher.pushCanonical(encoder.encode("first"));
    expect(deltaEvents(store)).toHaveLength(0);
    expect(timer.callbacks.size).toBe(1);

    timer.runAll();
    expect(deltaEvents(store)).toEqual([{
      type: "tool-output-delta",
      toolCallId: "call-1",
      toolName: "bash",
      delta: "STDOUT:\nfirst",
      omittedBytes: 0,
      liveLimitReached: false,
    }]);

    publisher.pushCanonical(encoder.encode("\nlast"));
    publisher.flush();
    expect(deltaEvents(store).at(-1)?.delta).toBe("\nlast");
    expect(timer.callbacks.size).toBe(0);
  });

  test("retains a UTF-8 safe suffix and reports omitted bytes", () => {
    const { store, publisher } = createPublisher({ eventMaxBytes: 8 });

    publisher.pushCanonical(encoder.encode("abcd"));
    publisher.pushCanonical(encoder.encode("😀ef"));
    publisher.flush();

    expect(deltaEvents(store)).toEqual([{
      type: "tool-output-delta",
      toolCallId: "call-1",
      toolName: "bash",
      delta: "cd😀ef",
      omittedBytes: 2,
      liveLimitReached: false,
    }]);
  });

  test("marks the final per-call event and ignores later output", () => {
    const { store, publisher } = createPublisher({ eventMaxCount: 2 });

    publisher.pushCanonical(encoder.encode("one"));
    publisher.flush();
    publisher.pushCanonical(encoder.encode("two"));
    publisher.flush();
    publisher.pushCanonical(encoder.encode("three"));
    publisher.flush();

    expect(deltaEvents(store).map((event) => ({
      delta: event.delta,
      liveLimitReached: event.liveLimitReached,
    }))).toEqual([
      { delta: "one", liveLimitReached: false },
      { delta: "two", liveLimitReached: true },
    ]);
    expect(publisher.stopped).toBe(true);
  });

  test("the real 10,000th delta marks the cap and the 10,001st produces no event", () => {
    const { store, publisher } = createPublisher();

    for (let index = 1; index <= 10_001; index += 1) {
      publisher.pushCanonical(encoder.encode(`delta-${index}`));
      publisher.flush();
    }

    const events = deltaEvents(store);
    expect(events).toHaveLength(10_000);
    expect(events[9_998]).toMatchObject({
      delta: "delta-9999",
      liveLimitReached: false,
    });
    expect(events[9_999]).toMatchObject({
      delta: "delta-10000",
      liveLimitReached: true,
    });
    expect(events.some((event) => event.delta === "delta-10001")).toBe(false);
    expect(publisher.stopped).toBe(true);
  });

  test("concurrent publishers share the unpublished Session suffix budget", async () => {
    const store = createMockStore({
      nextEventId: MAX_EVENTS - 1,
      publishableNextEventId: 0,
    });
    const first = createPublisher({ store, toolCallId: "first" }).publisher;
    const second = createPublisher({ store, toolCallId: "second" }).publisher;

    await Promise.all([
      Promise.resolve().then(() => {
        first.pushCanonical(encoder.encode("first contender"));
        first.flush();
      }),
      Promise.resolve().then(() => {
        second.pushCanonical(encoder.encode("second contender"));
        second.flush();
      }),
    ]);

    const events = deltaEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool-output-delta",
      toolName: "bash",
      omittedBytes: 0,
      liveLimitReached: true,
    });
    expect(["first contender", "second contender"]).toContain(events[0]?.delta);
    expect(store.getState().nextEventId - store.getState().publishableNextEventId)
      .toBe(MAX_EVENTS);
    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(true);
  });

  test("publisher failures and dispose never escape into tool execution", () => {
    const store = createMockStore();
    store.getState().append = () => {
      throw new Error("SSE projection failed");
    };
    const { publisher } = createPublisher({ store });

    publisher.pushCanonical(encoder.encode("partial"));
    expect(() => publisher.dispose()).not.toThrow();
    expect(publisher.stopped).toBe(true);
  });
});
