import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  PermissionDecision,
  PermissionRequest,
  QuestionAnswerBody,
  QuestionRequest,
} from "../api/types";
import type { WebSessionStoreState } from "../store/session-store";

type AttentionQueueHook = typeof import("./use-attention-queue").useAttentionQueue;
type MockSessionState = Pick<
  WebSessionStoreState,
  | "pendingPermissions"
  | "pendingQuestions"
  | "removePermissionRequest"
  | "removeQuestionRequest"
>;
type Selector<T> = (state: MockSessionState) => T;
type MutationOptions = { onSuccess?: () => void };

const removePermissionRequest = mock((_id: string) => {});
const removeQuestionRequest = mock((_id: string) => {});
const permissionMutate = mock(
  (_variables: { id: string; decision: PermissionDecision }, _options?: MutationOptions) => {},
);
const questionMutate = mock(
  (_variables: { id: string; body: QuestionAnswerBody }, _options?: MutationOptions) => {},
);
let mockState: MockSessionState;

const getState = mock(() => mockState);
const createWebSessionStore = mock((_sessionId: string) => ({ getState }));
const useSessionStore = mock(<T,>(_sessionId: string, selector: Selector<T>): T => {
  return selector(mockState);
});
const usePostPermissionResponse = mock(() => ({ mutate: permissionMutate }));
const usePostQuestionAnswer = mock(() => ({ mutate: questionMutate }));

mock.module("react", () => ({
  useCallback: <T extends (...args: never[]) => unknown,>(callback: T) => callback,
  useMemo: <T,>(factory: () => T) => factory(),
}));

mock.module("../store/session-store", () => ({
  createWebSessionStore,
  useSessionStore,
}));

mock.module("../api/mutations", () => ({
  usePostPermissionResponse,
  usePostQuestionAnswer,
}));

let useAttentionQueue: AttentionQueueHook;

function resetState(): void {
  mockState = {
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    removePermissionRequest,
    removeQuestionRequest,
  };
}

function makePermission(id: string): PermissionRequest {
  return {
    id,
    sessionId: "session-1",
    toolName: "bash",
    toolCallId: `tool-${id}`,
    input: { command: "pwd" },
    description: `Permission ${id}`,
  };
}

function makeQuestion(id: string): QuestionRequest {
  return {
    id,
    sessionId: "session-1",
    toolName: "ask_user",
    toolCallId: `tool-${id}`,
    questions: [{ text: `Question ${id}` }],
  };
}

function renderHook<T>(hook: () => T): { result: { current: T } } {
  return { result: { current: hook() } };
}

describe("useAttentionQueue", () => {
  beforeAll(async () => {
    ({ useAttentionQueue } = await import("./use-attention-queue"));
  });

  beforeEach(() => {
    resetState();
    removePermissionRequest.mockClear();
    removeQuestionRequest.mockClear();
    permissionMutate.mockClear();
    questionMutate.mockClear();
    getState.mockClear();
    createWebSessionStore.mockClear();
    useSessionStore.mockClear();
    usePostPermissionResponse.mockClear();
    usePostQuestionAnswer.mockClear();
    permissionMutate.mockImplementation(() => {});
    questionMutate.mockImplementation(() => {});
  });

  test("initial state has empty arrays", () => {
    const rendered = renderHook(() => useAttentionQueue("session-1"));

    expect(rendered.result.current.permissions).toEqual([]);
    expect(rendered.result.current.questions).toEqual([]);
  });

  test("permissions array reflects store state", () => {
    mockState.pendingPermissions = new Map([
      ["permission-b", makePermission("permission-b")],
      ["permission-a", makePermission("permission-a")],
    ]);

    const rendered = renderHook(() => useAttentionQueue("session-1"));

    expect(rendered.result.current.permissions.map((permission) => permission.id)).toEqual([
      "permission-a",
      "permission-b",
    ]);
  });

  test("questions array reflects store state", () => {
    mockState.pendingQuestions = new Map([
      ["question-b", makeQuestion("question-b")],
      ["question-a", makeQuestion("question-a")],
    ]);

    const rendered = renderHook(() => useAttentionQueue("session-1"));

    expect(rendered.result.current.questions.map((question) => question.id)).toEqual([
      "question-a",
      "question-b",
    ]);
  });

  test("respondPermission calls mutation and removes from store on success", () => {
    permissionMutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    const rendered = renderHook(() => useAttentionQueue("session-1"));

    rendered.result.current.respondPermission("permission-1", "approve_once");

    expect(permissionMutate.mock.calls[0]?.[0]).toEqual({
      id: "permission-1",
      decision: "approve_once",
    });
    expect(createWebSessionStore).toHaveBeenCalledWith("session-1");
    expect(removePermissionRequest).toHaveBeenCalledWith("permission-1");
  });

  test("respondQuestion calls mutation and removes from store on success", () => {
    questionMutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    const rendered = renderHook(() => useAttentionQueue("session-1"));
    const body: QuestionAnswerBody = { answers: [["yes"]] };

    rendered.result.current.respondQuestion("question-1", body);

    expect(questionMutate.mock.calls[0]?.[0]).toEqual({
      id: "question-1",
      body,
    });
    expect(createWebSessionStore).toHaveBeenCalledWith("session-1");
    expect(removeQuestionRequest).toHaveBeenCalledWith("question-1");
  });

  test("respondPermission does not remove on mutation failure", () => {
    permissionMutate.mockImplementation(() => {});
    const rendered = renderHook(() => useAttentionQueue("session-1"));

    rendered.result.current.respondPermission("permission-1", "deny");

    expect(permissionMutate.mock.calls[0]?.[0]).toEqual({
      id: "permission-1",
      decision: "deny",
    });
    expect(removePermissionRequest).not.toHaveBeenCalled();
  });
});
