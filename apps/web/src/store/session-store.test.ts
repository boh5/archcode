import { describe, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { PermissionTerminalEvent, QuestionTerminalEvent } from "@specra/protocol";
import type { PermissionRequest, QuestionRequest } from "../api/types";

type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

interface TransientTestState {
  pendingPermissions: Map<string, PermissionRequest>;
  pendingQuestions: Map<string, QuestionRequest>;
  lastEventId: string | null;
  connectionState: ConnectionState;
  addPermissionRequest: (request: PermissionRequest) => void;
  removePermissionRequest: (id: string) => void;
  addQuestionRequest: (request: QuestionRequest) => void;
  removeQuestionRequest: (id: string) => void;
  handlePermissionTerminal: (event: PermissionTerminalEvent) => void;
  handleQuestionTerminal: (event: QuestionTerminalEvent) => void;
  resetTransientState: () => void;
  setConnectionState: (state: ConnectionState) => void;
  setLastEventId: (id: string | null) => void;
}

function makePermission(id: string): PermissionRequest {
  return {
    id,
    sessionId: "test-session",
    toolName: "bash",
    toolCallId: "",
    input: { command: "pwd" },
    description: "Run a command",
  };
}

function makeQuestion(id: string): QuestionRequest {
  return {
    id,
    sessionId: "test-session",
    toolName: "ask_user",
    toolCallId: "",
    questions: [{ text: "Continue?" }],
  };
}

function createTestStore() {
  return createStore<TransientTestState>((set) => ({
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    lastEventId: null,
    connectionState: "connecting",
    addPermissionRequest: (request: PermissionRequest) => {
      set((state) => ({
        pendingPermissions: new Map(state.pendingPermissions).set(request.id, request),
      }));
    },
    removePermissionRequest: (id: string) => {
      set((state) => {
        const pendingPermissions = new Map(state.pendingPermissions);
        pendingPermissions.delete(id);
        return { pendingPermissions };
      });
    },
    addQuestionRequest: (request: QuestionRequest) => {
      set((state) => ({
        pendingQuestions: new Map(state.pendingQuestions).set(request.id, request),
      }));
    },
    removeQuestionRequest: (id: string) => {
      set((state) => {
        const pendingQuestions = new Map(state.pendingQuestions);
        pendingQuestions.delete(id);
        return { pendingQuestions };
      });
    },
    handlePermissionTerminal: (event: PermissionTerminalEvent) => {
      set((state) => {
        const pendingPermissions = new Map(state.pendingPermissions);
        pendingPermissions.delete(event.permissionId);
        return { pendingPermissions };
      });
    },
    handleQuestionTerminal: (event: QuestionTerminalEvent) => {
      set((state) => {
        const pendingQuestions = new Map(state.pendingQuestions);
        pendingQuestions.delete(event.questionId);
        return { pendingQuestions };
      });
    },
    resetTransientState: () => {
      set({
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        connectionState: "connecting",
        lastEventId: null,
      });
    },
    setConnectionState: (connectionState: ConnectionState) => {
      set({ connectionState });
    },
    setLastEventId: (lastEventId: string | null) => {
      set({ lastEventId });
    },
  }));
}

describe("handlePermissionTerminal", () => {
  test("removes pending permission by permissionId", () => {
    const store = createTestStore();
    const state = store.getState();

    state.addPermissionRequest(makePermission("perm-1"));
    state.addPermissionRequest(makePermission("perm-2"));

    expect(store.getState().pendingPermissions.has("perm-1")).toBe(true);
    expect(store.getState().pendingPermissions.has("perm-2")).toBe(true);
    expect(store.getState().pendingPermissions.size).toBe(2);

    const terminal: PermissionTerminalEvent = {
      type: "permission.terminal",
      permissionId: "perm-1",
      status: "resolved",
    };
    state.handlePermissionTerminal(terminal);

    expect(store.getState().pendingPermissions.has("perm-1")).toBe(false);
    expect(store.getState().pendingPermissions.has("perm-2")).toBe(true);
    expect(store.getState().pendingPermissions.size).toBe(1);
  });

  test("is a no-op for non-existent permissionId", () => {
    const store = createTestStore();
    const state = store.getState();

    state.addPermissionRequest(makePermission("perm-1"));

    const terminal: PermissionTerminalEvent = {
      type: "permission.terminal",
      permissionId: "non-existent",
      status: "cancelled",
    };

    expect(() => {
      state.handlePermissionTerminal(terminal);
    }).not.toThrow();
    expect(store.getState().pendingPermissions.size).toBe(1);
  });
});

describe("handleQuestionTerminal", () => {
  test("removes pending question by questionId", () => {
    const store = createTestStore();
    const state = store.getState();

    state.addQuestionRequest(makeQuestion("q-1"));
    state.addQuestionRequest(makeQuestion("q-2"));

    expect(store.getState().pendingQuestions.has("q-1")).toBe(true);
    expect(store.getState().pendingQuestions.has("q-2")).toBe(true);
    expect(store.getState().pendingQuestions.size).toBe(2);

    const terminal: QuestionTerminalEvent = {
      type: "question.terminal",
      questionId: "q-1",
      status: "resolved",
      answer: "yes",
    };
    state.handleQuestionTerminal(terminal);

    expect(store.getState().pendingQuestions.has("q-1")).toBe(false);
    expect(store.getState().pendingQuestions.has("q-2")).toBe(true);
    expect(store.getState().pendingQuestions.size).toBe(1);
  });

  test("is a no-op for non-existent questionId", () => {
    const store = createTestStore();
    const state = store.getState();

    state.addQuestionRequest(makeQuestion("q-1"));

    const terminal: QuestionTerminalEvent = {
      type: "question.terminal",
      questionId: "non-existent",
      status: "cancelled",
    };

    expect(() => {
      state.handleQuestionTerminal(terminal);
    }).not.toThrow();
    expect(store.getState().pendingQuestions.size).toBe(1);
  });
});

describe("resetTransientState", () => {
  test("clears pendingPermissions, pendingQuestions, resets connectionState and lastEventId", () => {
    const store = createTestStore();
    const state = store.getState();

    state.addPermissionRequest(makePermission("perm-1"));
    state.addPermissionRequest(makePermission("perm-2"));
    state.addQuestionRequest(makeQuestion("q-1"));
    state.setConnectionState("open");
    state.setLastEventId("event-42");

    expect(store.getState().pendingPermissions.size).toBe(2);
    expect(store.getState().pendingQuestions.size).toBe(1);
    expect(store.getState().connectionState).toBe("open");
    expect(store.getState().lastEventId).toBe("event-42");

    state.resetTransientState();

    expect(store.getState().pendingPermissions.size).toBe(0);
    expect(store.getState().pendingQuestions.size).toBe(0);
    expect(store.getState().connectionState).toBe("connecting");
    expect(store.getState().lastEventId).toBeNull();
  });

  test("is safe to call with empty state", () => {
    const store = createTestStore();
    const state = store.getState();

    expect(() => {
      state.resetTransientState();
    }).not.toThrow();

    expect(store.getState().pendingPermissions.size).toBe(0);
    expect(store.getState().pendingQuestions.size).toBe(0);
    expect(store.getState().connectionState).toBe("connecting");
    expect(store.getState().lastEventId).toBeNull();
  });
});
