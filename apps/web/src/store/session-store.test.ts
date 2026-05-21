import { beforeEach, describe, expect, test } from "bun:test";
import type { GlobalSessionEventEnvelope, SessionEventPayload } from "@specra/protocol";
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
      childSessionIds: ["child"],
      subAgentDescriptions: [["child", "Explore"]],
      eventCursor: 0,
    });

    store.getState().initializeFromSnapshot({
      messages: [],
      steps: [],
      todos: [],
      reminders: [],
      title: null,
      childSessionIds: [],
      parentSessionId: undefined,
      subAgentDescriptions: [],
      eventCursor: 5,
    });

    const state = store.getState();
    expect(state.messages).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(state.todos).toEqual([]);
    expect(state.reminders).toEqual([]);
    expect(state.title).toBeNull();
    expect(Array.from(state.childSessionIds)).toEqual([]);
    expect(state.parentSessionId).toBeUndefined();
    expect(Array.from(state.subAgentDescriptions)).toEqual([]);
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
