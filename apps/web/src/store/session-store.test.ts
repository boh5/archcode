import { beforeEach, describe, expect, test } from "bun:test";
import type {
  CompressionBlockSnapshot,
  CompressionStateSnapshot,
  GlobalSessionEventEnvelope,
  SessionEventPayload,
  SessionMessage,
} from "@archcode/protocol";
import {
  createWebSessionStore,
  evictIdleSessionStores,
  findWebSessionStore,
  markSessionForeground,
  __resetWebSessionStoresForTest,
} from "./session-store";

const requestedModelSelection = {
  mode: "agent_default" as const,
  selection: { model: "test:model" },
};
const binding = { selection: { model: "test:model" }, providerId: "test", modelId: "model", providerDisplayName: "Test", modelDisplayName: "Test Model", resolution: "agent_default" as const, modelRuntimeRevision: "m1" };

function event(eventId: number, payload: SessionEventPayload): GlobalSessionEventEnvelope {
  return {
    type: "event",
    slug: "demo",
    sessionId: "session-1",
    eventId,
    createdAt: 1_700_000_000_000 + eventId,
    payload,
    agentName: "engineer",
  };
}

function committedMessage(content: string, suffix: string): SessionEventPayload {
  return {
    type: "session.messages_committed",
    executionId: `execution-${suffix}`,
    messages: [{
      id: `message-${suffix}`,
      clientRequestId: `request-${suffix}`,
      role: "user",
      parts: [{ type: "text", id: `part-${suffix}`, text: content, createdAt: 1, completedAt: 1 }],
      createdAt: 1,
      completedAt: 1,
      executionId: `execution-${suffix}`,
      modelAudit: { requested: requestedModelSelection, actual: requestedModelSelection.selection },
    }],
  };
}

describe("web session store registry", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("findWebSessionStore returns existing stores without creating missing stores", () => {
    expect(findWebSessionStore("registry-session", "registry-slug")).toBeUndefined();

    const store = createWebSessionStore("registry-session", "registry-slug");

    expect(findWebSessionStore("registry-session", "registry-slug")).toBe(store);
    expect(findWebSessionStore("registry-session", "other-slug")).toBeUndefined();
  });

  test("new session stores carry root identity without removed child metadata", () => {
    const rootStore = createWebSessionStore("root-session", "identity");
    const childStore = createWebSessionStore("child-session", "identity");

    childStore.getState().initializeFromSnapshot({
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      eventCursor: -1,
    });

    expect(rootStore.getState().rootSessionId).toBe("root-session");
    expect(rootStore.getState().agentName).toBeNull();
    expect(childStore.getState().rootSessionId).toBe("root-session");
    expect(childStore.getState().parentSessionId).toBe("root-session");
    expect(rootStore.getState()).not.toHaveProperty("childSessionIds");
    expect(rootStore.getState()).not.toHaveProperty("subAgentDescriptions");
    expect(childStore.getState()).not.toHaveProperty("childSessionIds");
    expect(childStore.getState()).not.toHaveProperty("subAgentDescriptions");
  });

  test("hydrates durable selection state and tracks the active execution binding", () => {
    const store = createWebSessionStore("model-state", "demo");
    store.getState().initializeFromSnapshot({
      modelSelection: { revision: 2 },
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
      activeModelBinding: undefined,
      eventCursor: -1,
    });
    expect(store.getState().nextModelSelection?.resolved).toEqual(binding);
    store.getState().applyRemoteEnvelope({ ...event(0, { type: "execution-start", executionId: "execution-model", binding, origin: "user_message" }), sessionId: "model-state" });
    expect(store.getState().activeModelBinding).toEqual(binding);
    store.getState().applyRemoteEnvelope({ ...event(1, { type: "execution-end", status: "completed" }), sessionId: "model-state" });
    expect(store.getState().activeModelBinding).toBeUndefined();
  });

  test("tracks Session cwd from snapshots and formal cwd transition events", () => {
    const store = createWebSessionStore("session-1", "demo");
    store.getState().initializeFromSnapshot({ cwd: "/repo", eventCursor: -1 });
    expect(store.getState().cwd).toBe("/repo");

    store.getState().applyRemoteEnvelope(event(0, {
      type: "session.cwd_changed",
      previousCwd: "/repo",
      cwd: "/repo.worktrees/session-1",
    }));

    expect(store.getState().cwd).toBe("/repo.worktrees/session-1");
  });

  test("does not infer Session cwd from worktree tool-result metadata", () => {
    const store = createWebSessionStore("session-cwd-meta", "demo");
    store.getState().initializeFromSnapshot({ cwd: "/repo", eventCursor: -1 });

    store.getState().applyRemoteEnvelope({
      ...event(0, {
        type: "tool-result",
        toolCallId: "worktree-enter-1",
        toolName: "worktree_enter",
        output: "changed",
        isError: false,
        meta: { sessionCwdChanged: true, previousCwd: "/repo", cwd: "/wrong-source" },
      }),
      sessionId: "session-cwd-meta",
    });

    expect(store.getState().cwd).toBe("/repo");
  });

  test("projects child session links from remote events and snapshots", () => {
    const store = createWebSessionStore("session-1", "demo");
    const link = {
      parentSessionId: "session-1",
      parentToolCallId: "tool-call-1",
      toolName: "delegate",
      childSessionId: "child-1",
      childAgentName: "explore",
      title: "Explore child",
      depth: 1,
      background: true,
      status: "linked" as const,
      createdAt: 100,
    };
    const completed = {
      ...link,
      status: "completed" as const,
      endedAt: 200,
      durationMs: 100,
      summary: "Done",
    };

    store.getState().applyRemoteEnvelope(event(0, { type: "tool-child-session-link", link }));
    store.getState().applyRemoteEnvelope(event(1, { type: "tool-child-session-link", link: completed }));

    expect(store.getState().childSessionLinks).toEqual([completed]);

    store.getState().initializeFromSnapshot({
      childSessionLinks: [link],
      eventCursor: 1,
    });

    expect(store.getState().childSessionLinks).toEqual([link]);
  });

  test("evicts least-recent idle stores down to twenty", () => {
    for (let index = 0; index < 22; index += 1) {
      createWebSessionStore(`idle-${index}`, "lru");
    }

    evictIdleSessionStores();

    expect(findWebSessionStore("idle-0", "lru")).toBeUndefined();
    expect(findWebSessionStore("idle-1", "lru")).toBeUndefined();
    for (let index = 2; index < 22; index += 1) {
      expect(findWebSessionStore(`idle-${index}`, "lru")).toBeDefined();
    }
  });

  test("does not evict foreground, running, or streaming stores", () => {
    const foreground = createWebSessionStore("foreground", "pinned");
    const running = createWebSessionStore("running", "pinned");
    const streaming = createWebSessionStore("streaming", "pinned");

    markSessionForeground("pinned", "foreground", true);
    running.setState({ isRunning: true });
    streaming.setState({ isStreamingModel: true });

    for (let index = 0; index < 22; index += 1) {
      createWebSessionStore(`evictable-${index}`, "pinned");
    }

    evictIdleSessionStores();

    expect(findWebSessionStore("foreground", "pinned")).toBe(foreground);
    expect(findWebSessionStore("running", "pinned")).toBe(running);
    expect(findWebSessionStore("streaming", "pinned")).toBe(streaming);
    expect(findWebSessionStore("evictable-0", "pinned")).toBeUndefined();
  });
});

describe("applyRemoteEnvelope", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("drops envelopes for other sessions without changing the store", () => {
    const store = createWebSessionStore("known", "demo");

    store.getState().applyRemoteEnvelope({ ...event(0, committedMessage("wrong", "wrong")), sessionId: "unknown" });

    expect(store.getState().nextEventId).toBe(0);
    expect(store.getState().events).toEqual([]);
  });

  test("dedupes stale and duplicate remote envelopes by server event id", () => {
    const store = createWebSessionStore("dedupe", "demo");
    const first = { ...event(0, committedMessage("hello", "first")), sessionId: "dedupe" };

    store.getState().applyRemoteEnvelope(first);
    store.getState().applyRemoteEnvelope(first);

    expect(store.getState().events.map((item) => item.id)).toEqual([0]);
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().nextEventId).toBe(1);
  });

  test("buffers gaps and drains only contiguous remote envelopes", () => {
    const store = createWebSessionStore("gap", "demo");

    store.getState().applyRemoteEnvelope({ ...event(1, committedMessage("second", "second")), sessionId: "gap" });
    expect(store.getState().events).toEqual([]);
    expect(store.getState().nextEventId).toBe(0);

    store.getState().applyRemoteEnvelope({ ...event(0, committedMessage("first", "first")), sessionId: "gap" });

    expect(store.getState().events.map((item) => item.id)).toEqual([0, 1]);
    expect(store.getState().messages.map((message) => message.parts[0]?.type === "text" ? message.parts[0].text : "")).toEqual([
      "first",
      "second",
    ]);
    expect(store.getState().nextEventId).toBe(2);
  });

  test("keeps one optimistic sending bubble until its durable client request arrives", () => {
    const store = createWebSessionStore("optimistic", "demo");
    store.getState().addLocalSendingMessage({
      clientRequestId: "request-1",
      content: "hello",
      requestedModelSelection,
      createdAt: 42,
    });
    expect(store.getState().localSendingMessages).toEqual([{
      clientRequestId: "request-1",
      content: "hello",
      createdAt: 42,
      status: "sending",
      requestedModelSelection,
    }]);
    store.getState().setLocalSendingMessageStatus("request-1", "retryable");
    expect(store.getState().localSendingMessages[0]?.status).toBe("retryable");

    store.getState().applyRemoteEnvelope({
      ...event(0, {
        type: "session.message_accepted",
        message: {
          id: "message-1",
          clientRequestId: "request-1",
          content: "hello",
          source: "user",
          state: "queued",
          revision: 1,
          acceptedAt: 43,
          updatedAt: 43,
          requestedModelSelection,
        },
      }),
      sessionId: "optimistic",
    });

    expect(store.getState().localSendingMessages).toEqual([]);
    expect(store.getState().pendingMessages).toHaveLength(1);
  });

  test("projects edit, steer, rollback, delete, and commit events in the ordinary timeline", () => {
    const store = createWebSessionStore("queue-lifecycle", "demo");
    const queued = {
      id: "message-1",
      clientRequestId: "request-1",
      content: "first",
      source: "user" as const,
      state: "queued" as const,
      revision: 1,
      acceptedAt: 10,
      updatedAt: 10,
      requestedModelSelection,
    };

    const apply = (eventId: number, payload: SessionEventPayload) => store.getState().applyRemoteEnvelope({
      ...event(eventId, payload),
      sessionId: "queue-lifecycle",
    });

    apply(0, { type: "session.message_accepted", message: queued });
    apply(1, { type: "session.message_edited", message: { ...queued, content: "edited", revision: 2, updatedAt: 11 } });
    apply(2, {
      type: "session.message_steer_claimed",
      message: { ...queued, content: "edited", state: "steering", revision: 3, updatedAt: 12, targetExecutionId: "execution-1" },
    });
    expect(store.getState().pendingMessages[0]).toMatchObject({ state: "steering", targetExecutionId: "execution-1" });

    apply(3, {
      type: "session.message_steer_rolled_back",
      message: { ...queued, content: "edited", revision: 4, updatedAt: 13 },
    });
    expect(store.getState().pendingMessages[0]).toMatchObject({ state: "queued", revision: 4 });

    apply(4, {
      type: "session.messages_committed",
      executionId: "execution-2",
      messages: [{
        id: "message-1",
        clientRequestId: "request-1",
        role: "user",
        parts: [{ type: "text", id: "part-1", text: "edited", createdAt: 14, completedAt: 14 }],
        createdAt: 14,
        completedAt: 14,
        executionId: "execution-2",
        modelAudit: { requested: requestedModelSelection, actual: requestedModelSelection.selection },
      }],
    });
    expect(store.getState().pendingMessages).toEqual([]);
    expect(store.getState().messages[0]).toMatchObject({ id: "message-1", clientRequestId: "request-1" });

    apply(5, { type: "session.message_accepted", message: { ...queued, id: "message-2", clientRequestId: "request-2" } });
    apply(6, { type: "session.message_deleted", messageId: "message-2", clientRequestId: "request-2", revision: 2, deletedAt: 15 });
    expect(store.getState().pendingMessages).toEqual([]);
  });

});

describe("initializeFromSnapshot", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("durable snapshot takes over an optimistic bubble by clientRequestId", () => {
    const store = createWebSessionStore("snapshot-optimistic", "demo");
    store.getState().addLocalSendingMessage({ clientRequestId: "request-1", content: "hello", requestedModelSelection, createdAt: 1 });

    store.getState().initializeFromSnapshot({
      pendingMessages: [{
        id: "message-1",
        clientRequestId: "request-1",
        content: "hello",
        source: "user",
        state: "queued",
        revision: 1,
        acceptedAt: 2,
        updatedAt: 2,
        requestedModelSelection,
      }],
      eventCursor: -1,
    });

    expect(store.getState().localSendingMessages).toEqual([]);
    expect(store.getState().pendingMessages).toHaveLength(1);
  });

  test("authoritatively overwrites fields with empty arrays, null title, and event cursor", () => {
    const store = createWebSessionStore("snapshot", "demo");

    store.getState().applyRemoteEnvelope({ ...event(0, committedMessage("old", "old")), sessionId: "snapshot" });
    store.getState().initializeFromSnapshot({
      title: "Existing",
      todos: [{ id: "todo-1", content: "todo", status: "pending" }],
      rootSessionId: "root-session-id",
      eventCursor: 0,
    });

    store.getState().initializeFromSnapshot({
      messages: [],
      steps: [],
      todos: [],
      reminders: [],
      title: null,
      rootSessionId: "root-session-id",
      parentSessionId: undefined,
      eventCursor: 5,
    });

    const state = store.getState();
    expect(state.messages).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(state.todos).toEqual([]);
    expect(state.reminders).toEqual([]);
    expect(state.title).toBeNull();
    expect(state.rootSessionId).toBe("root-session-id");
    expect(state.parentSessionId).toBeUndefined();
    expect(state.nextEventId).toBe(6);
    expect(state.eventOffset).toBe(6);
    expect(state.events).toEqual([]);
  });

  test("replays contiguous buffered remote events after snapshot cursor", () => {
    const store = createWebSessionStore("snapshot-buffer", "demo");

    store.getState().applyRemoteEnvelope({ ...event(6, committedMessage("six", "six")), sessionId: "snapshot-buffer" });
    store.getState().applyRemoteEnvelope({ ...event(8, committedMessage("eight", "eight")), sessionId: "snapshot-buffer" });
    store.getState().initializeFromSnapshot({ messages: [], eventCursor: 5 });

    expect(store.getState().events.map((item) => item.id)).toEqual([6]);
    expect(store.getState().nextEventId).toBe(7);
  });

  test("does not overwrite reducer-managed state when SSE is ahead of snapshot", () => {
    const store = createWebSessionStore("stale-guard", "demo");

    // Simulate SSE processing events up to event 5
    store.getState().applyRemoteEnvelope({ ...event(0, committedMessage("hello", "stale-hello")), sessionId: "stale-guard" });
    store.getState().applyRemoteEnvelope({ ...event(1, { type: "execution-start", executionId: "run-1" } as SessionEventPayload), sessionId: "stale-guard" });
    store.getState().applyRemoteEnvelope({ ...event(2, committedMessage("world", "stale-world")), sessionId: "stale-guard" });
    store.getState().applyRemoteEnvelope({ ...event(3, { type: "execution-end", executionId: "run-1", status: "completed" } as SessionEventPayload), sessionId: "stale-guard" });
    store.getState().applyRemoteEnvelope({ ...event(4, { type: "execution-start", executionId: "run-2" } as SessionEventPayload), sessionId: "stale-guard" });

    expect(store.getState().nextEventId).toBe(5);

    const messagesBeforeSnapshot = store.getState().messages;
    const stepsBeforeSnapshot = store.getState().steps;
    const statsBeforeSnapshot = store.getState().stats;

    // Simulate a stale snapshot from server with eventCursor=2 (behind SSE's nextEventId=5)
    store.getState().initializeFromSnapshot({
      messages: [],
      steps: [],
      stats: { messages: { user: 0, assistant: 0, total: 0 }, tools: { calls: 0, completed: 0, failed: 0 }, steps: { started: 0, completed: 0 }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 } },
      eventCursor: 2,
    });

    // Reducer-managed state should NOT be overwritten by stale snapshot
    expect(store.getState().messages).toEqual(messagesBeforeSnapshot);
    expect(store.getState().steps).toEqual(stepsBeforeSnapshot);
    expect(store.getState().stats).toEqual(statsBeforeSnapshot);

    // nextEventId should stay at 5 (not reset to 3)
    expect(store.getState().nextEventId).toBe(5);
  });

  test("does not roll model selection back when a stale snapshot follows selection SSE", () => {
    const store = createWebSessionStore("stale-model-selection", "demo");
    const latestSelection = { revision: 3, override: { model: "test:new-model" } };
    store.getState().initializeFromSnapshot({
      modelSelection: { revision: 1 },
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
      eventCursor: -1,
    });
    store.getState().applyRemoteEnvelope({
      ...event(0, { type: "session.model_selection_changed", modelSelection: latestSelection }),
      sessionId: "stale-model-selection",
    });

    store.getState().initializeFromSnapshot({
      modelSelection: { revision: 1 },
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
      eventCursor: -1,
    });

    expect(store.getState().modelSelection).toEqual(latestSelection);
    expect(store.getState().nextModelSelection).toBeUndefined();
  });

  test("does not clear an active binding when a stale snapshot follows execution-start SSE", () => {
    const store = createWebSessionStore("stale-active-binding", "demo");
    store.getState().applyRemoteEnvelope({
      ...event(0, { type: "execution-start", executionId: "execution-model", binding, origin: "user_message" }),
      sessionId: "stale-active-binding",
    });

    store.getState().initializeFromSnapshot({ activeModelBinding: undefined, eventCursor: -1 });

    expect(store.getState().activeModelBinding).toEqual(binding);
  });

  test("does not rewind the event log or cursor when a stale snapshot contains events", () => {
    const store = createWebSessionStore("stale-events", "demo");
    store.getState().applyRemoteEnvelope({ ...event(0, committedMessage("first", "first")), sessionId: "stale-events" });
    store.getState().applyRemoteEnvelope({ ...event(1, committedMessage("second", "second")), sessionId: "stale-events" });
    const eventsBeforeSnapshot = store.getState().events;

    store.getState().initializeFromSnapshot({
      events: [eventsBeforeSnapshot[0]!],
      eventCursor: 0,
    });

    expect(store.getState().events).toEqual(eventsBeforeSnapshot);
    expect(store.getState().nextEventId).toBe(2);
    expect(store.getState().eventOffset).toBe(0);
  });

  test("overwrites reducer-managed state when snapshot is current or ahead", () => {
    const store = createWebSessionStore("fresh-snapshot", "demo");

    // Local state has only processed 2 events
    store.getState().applyRemoteEnvelope({ ...event(0, committedMessage("hello", "fresh-hello")), sessionId: "fresh-snapshot" });
    store.getState().applyRemoteEnvelope({ ...event(1, { type: "execution-start", executionId: "run-1" } as SessionEventPayload), sessionId: "fresh-snapshot" });
    expect(store.getState().nextEventId).toBe(2);

    // Snapshot from server has up-to-date data (eventCursor matches)
    const snapshotMessages: SessionMessage[] = [{ id: "msg-1", role: "assistant", parts: [], createdAt: 1000 }];
    store.getState().initializeFromSnapshot({
      messages: snapshotMessages,
      steps: [],
      stats: { messages: { user: 3, assistant: 2, total: 5 }, tools: { calls: 3, completed: 2, failed: 0 }, steps: { started: 8, completed: 7 }, usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, reasoningTokens: 0, cachedInputTokens: 0 } },
      eventCursor: 2,
    });

    // Should overwrite because snapshot is not stale (cursor 2 >= local nextEventId-1)
    expect(store.getState().messages).toEqual(snapshotMessages);
    expect(store.getState().stats.tools.calls).toBe(3);
  });

  test("always updates scalar metadata fields even with stale snapshot", () => {
    const store = createWebSessionStore("stale-metadata", "demo");

    store.getState().applyRemoteEnvelope({ ...event(0, committedMessage("hello", "metadata-hello")), sessionId: "stale-metadata" });
    store.getState().applyRemoteEnvelope({ ...event(1, { type: "execution-start", executionId: "run-1" } as SessionEventPayload), sessionId: "stale-metadata" });

    store.getState().initializeFromSnapshot({
      title: "New Title",
      createdAt: 9999,
      rootSessionId: "root-session-id",
      parentSessionId: "parent-1",
      eventCursor: 0, // stale: snapshot is behind local state (nextEventId=2)
    });

    // Scalar metadata should still be updated even with stale snapshot
    expect(store.getState().title).toBe("New Title");
    expect(store.getState().createdAt).toBe(9999);
    expect(store.getState().rootSessionId).toBe("root-session-id");
    expect(store.getState().parentSessionId).toBe("parent-1");
  });
});

describe("focusSessionId", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("defaults to null and updates via setFocusSessionId", () => {
    const store = createWebSessionStore("focus-test", "demo");
    expect(store.getState().focusSessionId).toBeNull();

    store.getState().setFocusSessionId("child-123");
    expect(store.getState().focusSessionId).toBe("child-123");

    store.getState().setFocusSessionId(null);
    expect(store.getState().focusSessionId).toBeNull();
  });
});

describe("resetTransientState", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("resetTransientState does not reintroduce legacy pending confirmation state", () => {
    const store = createWebSessionStore("reset", "demo");
    const state = store.getState();

    expect(state).not.toHaveProperty("connectionState");
    expect(state).not.toHaveProperty("lastEventId");
    expect(state).not.toHaveProperty("pendingPermissions");
    expect(state).not.toHaveProperty("pendingQuestions");

    state.resetTransientState();

    expect(store.getState()).not.toHaveProperty("pendingPermissions");
    expect(store.getState()).not.toHaveProperty("pendingQuestions");
  });
});

function makeCompressionBlock(overrides: Partial<CompressionBlockSnapshot> = {}): CompressionBlockSnapshot {
  return {
    id: "block-1",
    ref: "b1",
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    range: {
      startMessageId: "first",
      endMessageId: "tail",
      startRef: "m0001",
      endRef: "m0002",
      startIndex: 0,
      endIndex: 1,
    },
    summary: "## Current Objective\nKeep going",
    childBlockRefs: [],
    protectedRefs: [],
    createdAt: 123456789,
    updatedAt: 123456789,
    ...overrides,
  };
}

function makeCompressionState(block: CompressionBlockSnapshot): CompressionStateSnapshot {
  return {
    refMap: {
      messageRefsById: { first: "m0001", tail: "m0002" },
      messageIdsByRef: { m0001: "first", m0002: "tail" },
      blockRefsById: { "block-1": "b1" },
      blockIdsByRef: { b1: "block-1" },
      nextMessageIndex: 3,
      nextBlockIndex: 2,
    },
    blocksByRef: { b1: block },
    activeBlockRefs: ["b1"],
    inactiveBlockRefs: [],
    supersededBlockRefs: [],
    failures: [],
    updatedAt: 123456789,
  };
}

describe("compression events and snapshot hydration", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("reduces compression.block_committed into compression state and compressionBlocks", () => {
    const store = createWebSessionStore("compress-1", "demo");
    const block = makeCompressionBlock();

    store.getState().applyRemoteEnvelope({
      ...event(0, { type: "compression.block_committed", block, state: makeCompressionState(block) }),
      sessionId: "compress-1",
    });

    const state = store.getState();
    expect(state.compression?.blocksByRef.b1?.status).toBe("active");
    expect(state.compression?.activeBlockRefs).toEqual(["b1"]);
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks?.[0]?.blockRef).toBe("b1");
    expect(state.compressionBlocks?.[0]?.strategy).toBe("dynamic-range");
    expect(state.compressionBlocks?.[0]?.summary).toContain("Keep going");
    expect(state.messages.some((m) => m.compacted === true)).toBe(false);
  });

  test("compact clears dynamic compression state and compression block parts", () => {
    const store = createWebSessionStore("compress-compact", "demo");
    const block = makeCompressionBlock();

    store.getState().applyRemoteEnvelope({
      ...event(0, { type: "compression.block_committed", block, state: makeCompressionState(block) }),
      sessionId: "compress-compact",
    });
    expect(store.getState().compression?.activeBlockRefs).toEqual(["b1"]);
    expect(store.getState().compressionBlocks).toHaveLength(1);

    store.getState().applyRemoteEnvelope({
      ...event(1, { type: "compact", summary: "summary", tailStartId: "missing" }),
      sessionId: "compress-compact",
    });

    expect(store.getState().compression).toBeUndefined();
    expect(store.getState().compressionBlocks).toEqual([]);
  });

  test("reduces compression.block_failed into compression failures without compacted flags", () => {
    const store = createWebSessionStore("compress-fail", "demo");

    store.getState().applyRemoteEnvelope({
      ...event(0, {
        type: "compression.block_failed",
        failure: { id: "failure-1", reason: "summary invalid", startRef: "m0001", endRef: "m0002", failedAt: 101 },
      }),
      sessionId: "compress-fail",
    });

    const state = store.getState();
    expect(state.compression?.failures).toEqual([
      { id: "failure-1", reason: "summary invalid", startRef: "m0001", endRef: "m0002", failedAt: 101 },
    ]);
    expect(state.compressionBlocks ?? []).toEqual([]);
  });

  test("reduces compression.ref_map_updated into compression refMap", () => {
    const store = createWebSessionStore("compress-refmap", "demo");

    store.getState().applyRemoteEnvelope({
      ...event(0, {
        type: "compression.ref_map_updated",
        refMap: {
          messageRefsById: { first: "m0001" },
          messageIdsByRef: { m0001: "first" },
          blockRefsById: {},
          blockIdsByRef: {},
          nextMessageIndex: 2,
          nextBlockIndex: 1,
        },
        updatedAt: 200,
      }),
      sessionId: "compress-refmap",
    });

    expect(store.getState().compression?.refMap.messageRefsById.first).toBe("m0001");
  });

  test("initializeFromSnapshot hydrates compression and compressionBlocks from session snapshot", () => {
    const store = createWebSessionStore("compress-snap", "demo");
    const block = makeCompressionBlock();
    const compression = makeCompressionState(block);

    store.getState().initializeFromSnapshot({
      compression,
      compressionBlocks: [
        {
          type: "compression-block",
          id: "compression:b1:part-1",
          blockRef: "b1",
          status: "active",
          strategy: "dynamic-range",
          trigger: "model_tool_call",
          summary: "## Current Objective\nKeep going",
          startRef: "m0001",
          endRef: "m0002",
          childBlockRefs: [],
          committedAt: 123456789,
        },
      ],
      eventCursor: 0,
    });

    const state = store.getState();
    expect(state.compression?.blocksByRef.b1?.strategy).toBe("dynamic-range");
    expect(state.compression?.activeBlockRefs).toEqual(["b1"]);
    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks?.[0]?.blockRef).toBe("b1");
  });

  test("does not overwrite compression when SSE is ahead of snapshot", () => {
    const store = createWebSessionStore("compress-stale", "demo");
    const block = makeCompressionBlock();

    store.getState().applyRemoteEnvelope({
      ...event(0, { type: "compression.block_committed", block, state: makeCompressionState(block) }),
      sessionId: "compress-stale",
    });
    store.getState().applyRemoteEnvelope({
      ...event(1, committedMessage("after", "compression-after")),
      sessionId: "compress-stale",
    });

    expect(store.getState().nextEventId).toBe(2);
    expect(store.getState().compression?.activeBlockRefs).toEqual(["b1"]);

    const staleBlock = makeCompressionBlock({ ref: "b2", id: "block-2" });
    store.getState().initializeFromSnapshot({
      compression: makeCompressionState(staleBlock),
      compressionBlocks: [],
      eventCursor: 0,
    });

    expect(store.getState().compression?.activeBlockRefs).toEqual(["b1"]);
    expect(store.getState().compression?.blocksByRef.b2).toBeUndefined();
  });
});
