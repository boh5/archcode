import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  PermissionDecision,
  PermissionRequest,
  QuestionAnswerBody,
  QuestionRequest,
} from "../api/types";
import { createAttentionQueueActions } from "./use-attention-queue";

type MockSessionState = Pick<
  import("../store/session-store").WebSessionStoreState,
  | "pendingPermissions"
  | "pendingQuestions"
  | "removePermissionRequest"
  | "removeQuestionRequest"
>;
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

describe("useAttentionQueue", () => {
  beforeEach(() => {
    resetState();
    removePermissionRequest.mockClear();
    removeQuestionRequest.mockClear();
    permissionMutate.mockClear();
    questionMutate.mockClear();
    getState.mockClear();
    permissionMutate.mockImplementation(() => {});
    questionMutate.mockImplementation(() => {});
  });

  test("initial state has empty arrays", () => {
    const permissions = [...mockState.pendingPermissions.values()].sort((left, right) => left.id.localeCompare(right.id));
    const questions = [...mockState.pendingQuestions.values()].sort((left, right) => left.id.localeCompare(right.id));

    expect(permissions).toEqual([]);
    expect(questions).toEqual([]);
  });

  test("permissions array reflects store state", () => {
    mockState.pendingPermissions = new Map([
      ["permission-b", makePermission("permission-b")],
      ["permission-a", makePermission("permission-a")],
    ]);

    const permissions = [...mockState.pendingPermissions.values()].sort((left, right) => left.id.localeCompare(right.id));

    expect(permissions.map((permission) => permission.id)).toEqual([
      "permission-a",
      "permission-b",
    ]);
  });

  test("questions array reflects store state", () => {
    mockState.pendingQuestions = new Map([
      ["question-b", makeQuestion("question-b")],
      ["question-a", makeQuestion("question-a")],
    ]);

    const questions = [...mockState.pendingQuestions.values()].sort((left, right) => left.id.localeCompare(right.id));

    expect(questions.map((question) => question.id)).toEqual([
      "question-a",
      "question-b",
    ]);
  });

  test("respondPermission calls mutation and removes from store on success", () => {
    permissionMutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    const actions = createAttentionQueueActions({
      postPermissionResponse: permissionMutate,
      postQuestionAnswer: questionMutate,
      getState,
    });

    actions.respondPermission("permission-1", "approve_once");

    expect(permissionMutate.mock.calls[0]?.[0]).toEqual({
      id: "permission-1",
      decision: "approve_once",
    });
    expect(removePermissionRequest).toHaveBeenCalledWith("permission-1");
  });

  test("respondQuestion calls mutation and removes from store on success", () => {
    questionMutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    const actions = createAttentionQueueActions({
      postPermissionResponse: permissionMutate,
      postQuestionAnswer: questionMutate,
      getState,
    });
    const body: QuestionAnswerBody = { answers: [["yes"]] };

    actions.respondQuestion("question-1", body);

    expect(questionMutate.mock.calls[0]?.[0]).toEqual({
      id: "question-1",
      body,
    });
    expect(removeQuestionRequest).toHaveBeenCalledWith("question-1");
  });

  test("respondPermission does not remove on mutation failure", () => {
    permissionMutate.mockImplementation(() => {});
    const actions = createAttentionQueueActions({
      postPermissionResponse: permissionMutate,
      postQuestionAnswer: questionMutate,
      getState,
    });

    actions.respondPermission("permission-1", "deny");

    expect(permissionMutate.mock.calls[0]?.[0]).toEqual({
      id: "permission-1",
      decision: "deny",
    });
    expect(removePermissionRequest).not.toHaveBeenCalled();
  });

  test("respondQuestion removes the pending question from the queue on success (terminal clearing)", () => {
    questionMutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    mockState.pendingQuestions = new Map([
      ["question-terminal-1", makeQuestion("question-terminal-1")],
    ]);

    const actions = createAttentionQueueActions({
      postPermissionResponse: permissionMutate,
      postQuestionAnswer: questionMutate,
      getState,
    });

    actions.respondQuestion("question-terminal-1", { answers: [["yes"]] });

    expect(questionMutate.mock.calls[0]?.[0]).toEqual({
      id: "question-terminal-1",
      body: { answers: [["yes"]] },
    });
    expect(removeQuestionRequest).toHaveBeenCalledWith("question-terminal-1");
  });

  test("respondQuestion does not remove from queue on mutation failure", () => {
    questionMutate.mockImplementation(() => {});
    mockState.pendingQuestions = new Map([
      ["question-fail-1", makeQuestion("question-fail-1")],
    ]);

    const actions = createAttentionQueueActions({
      postPermissionResponse: permissionMutate,
      postQuestionAnswer: questionMutate,
      getState,
    });

    actions.respondQuestion("question-fail-1", { answers: [["no"]] });

    expect(questionMutate.mock.calls[0]?.[0]).toEqual({
      id: "question-fail-1",
      body: { answers: [["no"]] },
    });
    expect(removeQuestionRequest).not.toHaveBeenCalled();
  });

  test("respondQuestion submits batched answers as a single payload", () => {
    questionMutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    const actions = createAttentionQueueActions({
      postPermissionResponse: permissionMutate,
      postQuestionAnswer: questionMutate,
      getState,
    });

    const batchedAnswers: string[][] = [["Alpha"], ["Beta"], ["Gamma"]];
    actions.respondQuestion("question-batch-1", { answers: batchedAnswers });

    expect(questionMutate).toHaveBeenCalledTimes(1);
    expect(questionMutate.mock.calls[0]?.[0]).toEqual({
      id: "question-batch-1",
      body: { answers: batchedAnswers },
    });
    expect(removeQuestionRequest).toHaveBeenCalledWith("question-batch-1");
  });

  test("respondQuestion submits error cancellation payload", () => {
    questionMutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    const actions = createAttentionQueueActions({
      postPermissionResponse: permissionMutate,
      postQuestionAnswer: questionMutate,
      getState,
    });

    actions.respondQuestion("question-cancel-1", { isError: true, reason: "Cancelled by user" });

    expect(questionMutate).toHaveBeenCalledTimes(1);
    expect(questionMutate.mock.calls[0]?.[0]).toEqual({
      id: "question-cancel-1",
      body: { isError: true, reason: "Cancelled by user" },
    });
    expect(removeQuestionRequest).toHaveBeenCalledWith("question-cancel-1");
  });
});
