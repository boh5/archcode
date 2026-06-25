import { beforeEach, describe, expect, test } from "bun:test";
import type { GlobalSessionEventEnvelope, SessionEventPayload } from "@archcode/protocol";
import type { PermissionRequest, QuestionRequest } from "../api/types";
import {
  createWebSessionStore,
  evictIdleSessionStores,
  findWebSessionStore,
  markSessionForeground,
  __resetWebSessionStoresForTest,
} from "./session-store";

function event(eventId: number, payload: SessionEventPayload): GlobalSessionEventEnvelope {
  return {
    type: "event",
    slug: "demo",
    sessionId: "session-1",
    eventId,
    createdAt: 1_700_000_000_000 + eventId,
    kind: payload.type,
    payload,
  };
}

function userMessage(content: string): SessionEventPayload {
  return { type: "user-message", content };
}

function makePermission(id: string, sessionId = "test-session"): PermissionRequest {
  return {
    id,
    sessionId,
    toolName: "bash",
    toolCallId: "",
    input: { command: "pwd" },
    description: "Run a command",
  };
}

function makeQuestion(id: string, sessionId = "test-session"): QuestionRequest {
  return {
    id,
    sessionId,
    toolName: "ask_user",
    toolCallId: "",
    questions: [{ text: "Continue?" }],
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
    expect(childStore.getState().rootSessionId).toBe("root-session");
    expect(childStore.getState().parentSessionId).toBe("root-session");
    expect(rootStore.getState()).not.toHaveProperty("childSessionIds");
    expect(rootStore.getState()).not.toHaveProperty("subAgentDescriptions");
    expect(childStore.getState()).not.toHaveProperty("childSessionIds");
    expect(childStore.getState()).not.toHaveProperty("subAgentDescriptions");
  });

  test("projects child session links from remote events and snapshots", () => {
    const store = createWebSessionStore("session-1", "demo");
    const link = {
      parentSessionId: "session-1",
      parentToolCallId: "tool-call-1",
      toolName: "delegate",
      childSessionId: "child-1",
      childAgentName: "explore",
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

  test("does not evict foreground, running, streaming, or pending-confirmation stores", () => {
    const foreground = createWebSessionStore("foreground", "pinned");
    const running = createWebSessionStore("running", "pinned");
    const streaming = createWebSessionStore("streaming", "pinned");
    const pendingPermission = createWebSessionStore("pending-permission", "pinned");
    const pendingQuestion = createWebSessionStore("pending-question", "pinned");

    markSessionForeground("pinned", "foreground", true);
    running.setState({ isRunning: true });
    streaming.setState({ isStreamingModel: true });
    pendingPermission.getState().addPermissionRequest(makePermission("perm", "pending-permission"));
    pendingQuestion.getState().addQuestionRequest(makeQuestion("question", "pending-question"));

    for (let index = 0; index < 22; index += 1) {
      createWebSessionStore(`evictable-${index}`, "pinned");
    }

    evictIdleSessionStores();

    expect(findWebSessionStore("foreground", "pinned")).toBe(foreground);
    expect(findWebSessionStore("running", "pinned")).toBe(running);
    expect(findWebSessionStore("streaming", "pinned")).toBe(streaming);
    expect(findWebSessionStore("pending-permission", "pinned")).toBe(pendingPermission);
    expect(findWebSessionStore("pending-question", "pinned")).toBe(pendingQuestion);
    expect(findWebSessionStore("evictable-0", "pinned")).toBeUndefined();
  });
});

describe("applyRemoteEnvelope", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("drops envelopes for other sessions without changing the store", () => {
    const store = createWebSessionStore("known", "demo");

    store.getState().applyRemoteEnvelope({ ...event(0, userMessage("wrong")), sessionId: "unknown" });

    expect(store.getState().nextEventId).toBe(0);
    expect(store.getState().events).toEqual([]);
  });

  test("dedupes stale and duplicate remote envelopes by server event id", () => {
    const store = createWebSessionStore("dedupe", "demo");
    const first = { ...event(0, userMessage("hello")), sessionId: "dedupe" };

    store.getState().applyRemoteEnvelope(first);
    store.getState().applyRemoteEnvelope(first);

    expect(store.getState().events.map((item) => item.id)).toEqual([0]);
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().nextEventId).toBe(1);
  });

  test("buffers gaps and drains only contiguous remote envelopes", () => {
    const store = createWebSessionStore("gap", "demo");

    store.getState().applyRemoteEnvelope({ ...event(1, userMessage("second")), sessionId: "gap" });
    expect(store.getState().events).toEqual([]);
    expect(store.getState().nextEventId).toBe(0);

    store.getState().applyRemoteEnvelope({ ...event(0, userMessage("first")), sessionId: "gap" });

    expect(store.getState().events.map((item) => item.id)).toEqual([0, 1]);
    expect(store.getState().messages.map((message) => message.parts[0]?.type === "text" ? message.parts[0].text : "")).toEqual([
      "first",
      "second",
    ]);
    expect(store.getState().nextEventId).toBe(2);
  });

  test("adds and removes pending permission requests from remote envelopes", () => {
    const store = createWebSessionStore("permission-remote", "demo");

    store.getState().applyRemoteEnvelope({
      ...event(0, {
        type: "permission.request",
        permissionId: "perm-remote-1",
        toolName: "bash",
        args: { command: "pwd" },
        description: "Run pwd",
      }),
      sessionId: "permission-remote",
    });

    expect(store.getState().pendingPermissions.get("perm-remote-1")).toMatchObject({
      id: "perm-remote-1",
      sessionId: "permission-remote",
      toolName: "bash",
      input: { command: "pwd" },
      description: "Run pwd",
    });

    store.getState().applyRemoteEnvelope({
      ...event(1, {
        type: "permission.terminal",
        permissionId: "perm-remote-1",
        status: "resolved",
      }),
      sessionId: "permission-remote",
    });

    expect(store.getState().pendingPermissions.size).toBe(0);
  });

  test("adds and removes pending question requests from remote envelopes", () => {
    const store = createWebSessionStore("question-remote", "demo");

    store.getState().applyRemoteEnvelope({
      ...event(0, {
        type: "question.request",
        questionId: "question-remote-1",
        question: JSON.stringify({ toolName: "ask_user", toolCallId: "tc-1", questions: [{ question: "Continue?", header: "Q1", options: [], custom: true }] }),
      }),
      sessionId: "question-remote",
    });

    expect(store.getState().pendingQuestions.get("question-remote-1")).toMatchObject({
      id: "question-remote-1",
      sessionId: "question-remote",
      toolName: "ask_user",
      toolCallId: "tc-1",
      questions: [{ question: "Continue?", header: "Q1", options: [], custom: true }],
    });

    store.getState().applyRemoteEnvelope({
      ...event(1, {
        type: "question.terminal",
        questionId: "question-remote-1",
        status: "resolved",
        answer: "Yes",
      }),
      sessionId: "question-remote",
    });

    expect(store.getState().pendingQuestions.size).toBe(0);
  });

  test("batched question.request with 3 questions stores all 3 in a single pending entry", () => {
    const store = createWebSessionStore("question-batched", "demo");

    store.getState().applyRemoteEnvelope({
      ...event(0, {
        type: "question.request",
        questionId: "question-batch-1",
        question: JSON.stringify({
          toolName: "ask_user",
          toolCallId: "tc-batch-1",
          questions: [
            { question: "First?", header: "Q1", options: [{ label: "A", description: "" }], custom: false },
            { question: "Second?", header: "Q2", options: [{ label: "B", description: "" }], custom: false },
            { question: "Third?", header: "Q3", options: [{ label: "C", description: "" }], custom: false },
          ],
        }),
      }),
      sessionId: "question-batched",
    });

    const pending = store.getState().pendingQuestions.get("question-batch-1");
    expect(pending).toBeDefined();
    expect(pending!.questions).toHaveLength(3);
    expect(pending!.questions[0]).toMatchObject({ header: "Q1" });
    expect(pending!.questions[1]).toMatchObject({ header: "Q2" });
    expect(pending!.questions[2]).toMatchObject({ header: "Q3" });
  });

  test("question.terminal empties the queue and unpins the store", () => {
    const store = createWebSessionStore("question-terminal-clear", "demo");

    store.getState().applyRemoteEnvelope({
      ...event(0, {
        type: "question.request",
        questionId: "question-clear-1",
        question: JSON.stringify({ toolName: "ask_user", toolCallId: "tc-1", questions: [{ question: "Continue?" }] }),
      }),
      sessionId: "question-terminal-clear",
    });

    expect(store.getState().pendingQuestions.size).toBe(1);

    store.getState().applyRemoteEnvelope({
      ...event(1, {
        type: "question.terminal",
        questionId: "question-clear-1",
        status: "resolved",
        answer: "Yes",
      }),
      sessionId: "question-terminal-clear",
    });

    expect(store.getState().pendingQuestions.size).toBe(0);
    // The store should no longer be pinned by pending questions.
    // isPinned checks pendingPermissions.size > 0 || pendingQuestions.size > 0;
    // with both empty and no running/streaming/foreground flags, it is not pinned.
    const state = store.getState();
    expect(state.pendingPermissions.size).toBe(0);
    expect(state.pendingQuestions.size).toBe(0);
    expect(state.isRunning).toBe(false);
    expect(state.isStreamingModel).toBe(false);
  });
});

describe("initializeFromSnapshot", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("authoritatively overwrites fields with empty arrays, null title, and event cursor", () => {
    const store = createWebSessionStore("snapshot", "demo");

    store.getState().applyRemoteEnvelope({ ...event(0, userMessage("old")), sessionId: "snapshot" });
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

    store.getState().applyRemoteEnvelope({ ...event(6, userMessage("six")), sessionId: "snapshot-buffer" });
    store.getState().applyRemoteEnvelope({ ...event(8, userMessage("eight")), sessionId: "snapshot-buffer" });
    store.getState().initializeFromSnapshot({ messages: [], eventCursor: 5 });

    expect(store.getState().events.map((item) => item.id)).toEqual([6]);
    expect(store.getState().nextEventId).toBe(7);
  });

  test("does not overwrite reducer-managed state when SSE is ahead of snapshot", () => {
    const store = createWebSessionStore("stale-guard", "demo");

    // Simulate SSE processing events up to event 5
    store.getState().applyRemoteEnvelope({ ...event(0, userMessage("hello")), sessionId: "stale-guard" });
    store.getState().applyRemoteEnvelope({ ...event(1, { type: "execution-start", executionId: "run-1" } as SessionEventPayload), sessionId: "stale-guard" });
    store.getState().applyRemoteEnvelope({ ...event(2, userMessage("world")), sessionId: "stale-guard" });
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

  test("overwrites reducer-managed state when snapshot is current or ahead", () => {
    const store = createWebSessionStore("fresh-snapshot", "demo");

    // Local state has only processed 2 events
    store.getState().applyRemoteEnvelope({ ...event(0, userMessage("hello")), sessionId: "fresh-snapshot" });
    store.getState().applyRemoteEnvelope({ ...event(1, { type: "execution-start", executionId: "run-1" } as SessionEventPayload), sessionId: "fresh-snapshot" });
    expect(store.getState().nextEventId).toBe(2);

    // Snapshot from server has up-to-date data (eventCursor matches)
    const snapshotMessages = [{ id: "msg-1", role: "assistant" as const, parts: [], createdAt: 1000 }];
    store.getState().initializeFromSnapshot({
      messages: snapshotMessages as any,
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

    store.getState().applyRemoteEnvelope({ ...event(0, userMessage("hello")), sessionId: "stale-metadata" });
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

  test("clears scoped pending confirmations without transport cursor or connection state", () => {
    const store = createWebSessionStore("reset", "demo");
    const state = store.getState();

    state.addPermissionRequest(makePermission("perm-1", "reset"));
    state.addQuestionRequest(makeQuestion("question-1", "reset"));

    expect(state).not.toHaveProperty("connectionState");
    expect(state).not.toHaveProperty("lastEventId");

    state.resetTransientState();

    expect(store.getState().pendingPermissions.size).toBe(0);
    expect(store.getState().pendingQuestions.size).toBe(0);
  });
});
