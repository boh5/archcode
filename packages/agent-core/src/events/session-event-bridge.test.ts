import { beforeEach, describe, expect, test } from "bun:test";
import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { createEmptySessionStats, MAX_EVENTS } from "@archcode/protocol";
import type { SessionStoreState } from "../store/types";
import { SessionEventBridge } from "./session-event-bridge";

const workspaceRoot = "/workspace";

function createTestStore(sessionId: string): StoreApi<SessionStoreState> {
  let store: StoreApi<SessionStoreState>;
  store = createStore<SessionStoreState>((set, get) => ({
    sessionId,
    createdAt: Date.now(),
    cwd: workspaceRoot,
    agentName: "orchestrator",
    title: null,
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    todos: [],
    reminders: [],
    childSessionLinks: [],
    rootSessionId: sessionId,
    isRunning: false,
    isStreamingModel: false,
    readSnapshots: new Map(),
    executionCount: 0,
    lastTodoWriteStepIndex: null,
    lastTodoReminderStepIndex: null,
    todoStepReminderCount: 0,
    todoLoopContinuationCount: 0,
    todoContinuationStagnationCount: 0,
    lastTodoContinuationPendingCount: null,
    lastExtractionIndex: 0,
    lastExtractionTime: 0,
    events: [],
    eventOffset: 0,
    nextEventId: 0,
    append: (event) => {
      set((state) => {
        const envelope = {
          id: state.nextEventId,
          createdAt: Date.now(),
          kind: event.type,
          payload: event,
        };
        const events = [...state.events, envelope];
        let eventOffset = state.eventOffset;
        const nextEventId = state.nextEventId + 1;
        if (events.length > MAX_EVENTS) {
          const dropCount = events.length - MAX_EVENTS;
          events.splice(0, dropCount);
          eventOffset += dropCount;
        }
        return { events, eventOffset, nextEventId };
      });
    },
    setCwd: (cwd) => set({ cwd, readSnapshots: new Map() }),
    setTitle: (title) => set({ title }),
    setParentSessionId: (parentSessionId) => {
      if (get().parentSessionId !== undefined) return;
      set({ parentSessionId });
    },
    setGoalId: (goalId) => set({ goalId }),
    setLoopId: (loopId) => set({ loopId }),
    setSessionRole: (sessionRole) => set({ sessionRole }),
    toModelMessages: () => [],
  }));
  return store;
}

describe("SessionEventBridge", () => {
  let bridge: SessionEventBridge;

  beforeEach(() => {
    bridge = new SessionEventBridge();
  });

  test("forwards existing root subscription events with the global SSE wire shape", () => {
    const store = createTestStore("root");
    bridge.attachSession(workspaceRoot, "root", store);
    const received: unknown[] = [];

    const unsubscribe = bridge.subscribe({
      slug: "project",
      workspaceRoot,
      sessionId: "root",
      onEvent: (event) => received.push(event),
    });
    store.getState().append({ type: "system-notice", message: "hello" });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "event",
      slug: "project",
      sessionId: "root",
      eventId: 0,
      kind: "system-notice",
      payload: { type: "system-notice", message: "hello" },
    });
    unsubscribe();
  });

  test("forwards Session cwd transitions as first-class realtime events", () => {
    const store = createTestStore("root");
    bridge.attachSession(workspaceRoot, "root", store);
    const received: unknown[] = [];
    bridge.subscribe({
      slug: "project",
      workspaceRoot,
      sessionId: "root",
      onEvent: (event) => received.push(event),
    });

    store.getState().append({
      type: "session.cwd_changed",
      previousCwd: workspaceRoot,
      cwd: "/workspace-worktree",
    });

    expect(received).toEqual([
      expect.objectContaining({
        type: "event",
        kind: "session.cwd_changed",
        payload: {
          type: "session.cwd_changed",
          previousCwd: workspaceRoot,
          cwd: "/workspace-worktree",
        },
      }),
    ]);
  });

  test("attaches a child store after a subscription already exists", () => {
    const received: unknown[] = [];
    const unsubscribe = bridge.subscribe({
      slug: "project",
      workspaceRoot,
      sessionId: "child",
      onEvent: (event) => received.push(event),
    });
    const childStore = createTestStore("child");

    bridge.attachSession(workspaceRoot, "child", childStore);
    childStore.getState().append({ type: "system-notice", message: "child-ready" });

    expect(received).toMatchObject([
      { type: "event", slug: "project", sessionId: "child", kind: "system-notice" },
    ]);
    unsubscribe();
  });

  test("emits lagged reset when a subscriber cursor predates the store event offset", () => {
    const store = createTestStore("lagged");
    store.setState({
      eventOffset: 3,
      nextEventId: 5,
      events: [
        { id: 3, createdAt: 10, kind: "system-notice", payload: { type: "system-notice", message: "three" } },
        { id: 4, createdAt: 11, kind: "system-notice", payload: { type: "system-notice", message: "four" } },
      ],
    });
    const received: unknown[] = [];

    bridge.attachSession(workspaceRoot, "lagged", store);
    bridge.subscribe({
      slug: "project",
      workspaceRoot,
      sessionId: "lagged",
      onEvent: (event) => received.push(event),
    });

    expect(received).toEqual([{ type: "reset", slug: "project", sessionId: "lagged", reason: "lagged" }]);
  });

  test("detachSession removes store forwarding and subscriptions", () => {
    const store = createTestStore("detach");
    const received: unknown[] = [];
    bridge.attachSession(workspaceRoot, "detach", store);
    bridge.subscribe({
      slug: "project",
      workspaceRoot,
      sessionId: "detach",
      onEvent: (event) => received.push(event),
    });

    bridge.detachSession(workspaceRoot, "detach");
    store.getState().append({ type: "system-notice", message: "after-detach" });

    expect(received).toEqual([]);
  });
});
