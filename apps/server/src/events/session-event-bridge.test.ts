import { beforeEach, describe, expect, test } from "bun:test";
import { createSessionStore } from "@specra/agent-core";
import type { SessionStoreState } from "@specra/agent-core";
import type { GlobalSSEEvent } from "@specra/protocol";
import type { StoreApi } from "zustand";
import { GlobalEventBus } from "./global-event-bus";
import { registerSessionEventBridge, __setGlobalEventBusForTest, __resetSessionEventBridgesForTest } from "./session-event-bridge";

const createScopedSessionStore = createSessionStore as unknown as typeof createSessionStore & ((sessionId: string, workspaceRoot: string) => StoreApi<SessionStoreState>);

function createStore(sessionId: string, workspaceRoot: string): StoreApi<SessionStoreState> {
  return createScopedSessionStore(sessionId, workspaceRoot);
}

function appendNotice(store: StoreApi<SessionStoreState>, message: string): void {
  store.getState().append({ type: "system-notice", message });
}

describe("registerSessionEventBridge", () => {
  let bus: GlobalEventBus;
  let received: GlobalSSEEvent[];

  beforeEach(() => {
    bus = new GlobalEventBus();
    received = [];
    __resetSessionEventBridgesForTest();
    __setGlobalEventBusForTest(bus);
    bus.subscribe((event) => received.push(event));
  });

  test("forwards session-local event ids with global slug and session identity", () => {
    const storeOne = createStore("shared-event-id-a", "/tmp/specra-bridge-a");
    const storeTwo = createStore("shared-event-id-b", "/tmp/specra-bridge-b");

    registerSessionEventBridge({ slug: "alpha", workspaceRoot: "/tmp/specra-bridge-a", sessionId: "shared-event-id-a", store: storeOne });
    registerSessionEventBridge({ slug: "beta", workspaceRoot: "/tmp/specra-bridge-b", sessionId: "shared-event-id-b", store: storeTwo });

    appendNotice(storeOne, "one");
    appendNotice(storeTwo, "two");

    expect(received.map((event) => event.type)).toEqual(["event", "event"]);
    expect(received).toMatchObject([
      { type: "event", slug: "alpha", sessionId: "shared-event-id-a", eventId: 0, kind: "system-notice" },
      { type: "event", slug: "beta", sessionId: "shared-event-id-b", eventId: 0, kind: "system-notice" },
    ]);
  });

  test("unchanged nextEventId emits zero bus events", () => {
    const store = createStore("unchanged-next", "/tmp/specra-bridge-unchanged");
    registerSessionEventBridge({ slug: "same", workspaceRoot: "/tmp/specra-bridge-unchanged", sessionId: "unchanged-next", store });

    store.setState((current) => ({ title: current.title === null ? "renamed" : null }));

    expect(received).toHaveLength(0);
  });

  test("returned unsubscribe prevents further emissions", () => {
    const store = createStore("unsubscribe", "/tmp/specra-bridge-unsubscribe");
    const unsubscribe = registerSessionEventBridge({ slug: "gone", workspaceRoot: "/tmp/specra-bridge-unsubscribe", sessionId: "unsubscribe", store });

    appendNotice(store, "before");
    unsubscribe();
    appendNotice(store, "after");

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "event", slug: "gone", sessionId: "unsubscribe", eventId: 0 });
  });

  test("duplicate registration by workspace and session updates slug and store", () => {
    const workspaceRoot = "/tmp/specra-bridge-duplicate";
    const oldStore = createStore("duplicate-old", `${workspaceRoot}-old`);
    const newStore = createStore("duplicate-new", `${workspaceRoot}-new`);

    registerSessionEventBridge({ slug: "old", workspaceRoot, sessionId: "duplicate", store: oldStore });
    registerSessionEventBridge({ slug: "new", workspaceRoot, sessionId: "duplicate", store: newStore });

    appendNotice(oldStore, "old-store");
    appendNotice(newStore, "new-store");

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "event", slug: "new", sessionId: "duplicate", eventId: 0 });
  });

  test("lagged bridge emits scoped reset instead of stale replay", () => {
    const store = createStore("lagged", "/tmp/specra-bridge-lagged");
    appendNotice(store, "dropped");
    store.setState((current) => ({ events: [], eventOffset: current.nextEventId }));

    registerSessionEventBridge({ slug: "lag", workspaceRoot: "/tmp/specra-bridge-lagged", sessionId: "lagged", store });

    expect(received).toEqual([{ type: "reset", slug: "lag", sessionId: "lagged", reason: "lagged" }]);
  });
});
