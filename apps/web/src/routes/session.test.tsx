import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetWebSessionStoresForTest,
  createWebSessionStore,
  evictIdleSessionStores,
  findWebSessionStore,
  markSessionForeground,
} from "../store/session-store";

describe("SessionRoute store-level behavior", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("markSessionForeground(true) pins the store against eviction", () => {
    const store = createWebSessionStore("fg-pin", "demo");
    markSessionForeground("demo", "fg-pin", true);

    for (let i = 0; i < 22; i++) {
      createWebSessionStore(`evictable-${i}`, "demo");
    }

    evictIdleSessionStores();

    expect(findWebSessionStore("fg-pin", "demo")).toBe(store);
  });

  test("markSessionForeground(false) releases the pin, allowing eviction", () => {
    createWebSessionStore("fg-unpin", "demo");
    markSessionForeground("demo", "fg-unpin", true);
    markSessionForeground("demo", "fg-unpin", false);

    for (let i = 0; i < 22; i++) {
      createWebSessionStore(`evictable-unpin-${i}`, "demo");
    }

    evictIdleSessionStores();

    expect(findWebSessionStore("fg-unpin", "demo")).toBeUndefined();
  });

  test("getWebSessionStore followed by initializeFromSnapshot populates the store", () => {
    const slug = "demo";
    const sessionId = "route-snapshot";
    const sessionData = {
      messages: [{ id: "m1", role: "user" as const, parts: [{ type: "text" as const, id: "p1", text: "hello", createdAt: Date.now() }], createdAt: Date.now() }],
      steps: [],
      todos: [],
      reminders: [],
      title: "Test Session",
      childSessionIds: [],
      subAgentDescriptions: [] as [string, string][],
      eventCursor: 5,
    };

    const store = createWebSessionStore(sessionId, slug);
    store.getState().initializeFromSnapshot(sessionData);

    const state = store.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.title).toBe("Test Session");
    expect(state.nextEventId).toBe(6);
  });

  test("does not use per-session connection state from old SSE transport", () => {
    const store = createWebSessionStore("no-sse", "demo");
    const state = store.getState();

    expect(state).not.toHaveProperty("connectionState");
    expect(state).not.toHaveProperty("setConnectionState");
    expect(state).not.toHaveProperty("lastEventId");
    expect(state).not.toHaveProperty("setLastEventId");
  });
});
