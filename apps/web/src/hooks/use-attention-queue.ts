import { useCallback, useMemo } from "react";
import { usePostPermissionResponse, usePostQuestionAnswer } from "../api/mutations";
import type {
  PermissionDecision,
  PermissionRequest,
  QuestionAnswerBody,
  QuestionRequest,
} from "../api/types";
import type { WebSessionStoreState } from "../store/session-store";
import { createWebSessionStore, useSessionStore } from "../store/session-store";

export interface AttentionQueue {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  respondPermission: (id: string, response: PermissionDecision) => void;
  respondQuestion: (id: string, body: QuestionAnswerBody) => void;
}

export interface AttentionQueueDeps {
  postPermissionResponse: (
    variables: { id: string; decision: PermissionDecision },
    options?: { onSuccess?: () => void },
  ) => void;
  postQuestionAnswer: (
    variables: { id: string; body: QuestionAnswerBody },
    options?: { onSuccess?: () => void },
  ) => void;
  getState: () => Pick<WebSessionStoreState, "removePermissionRequest" | "removeQuestionRequest">;
}

function mapValuesSortedById<T extends { id: string }>(items: Map<string, T>): T[] {
  return [...items.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function createAttentionQueueActions(
  deps: AttentionQueueDeps,
): Pick<AttentionQueue, "respondPermission" | "respondQuestion"> {
  return {
    respondPermission: (id, response) => {
      deps.postPermissionResponse(
        { id, decision: response },
        {
          onSuccess: () => {
            deps.getState().removePermissionRequest(id);
          },
        },
      );
    },
    respondQuestion: (id, body) => {
      deps.postQuestionAnswer(
        { id, body },
        {
          onSuccess: () => {
            deps.getState().removeQuestionRequest(id);
          },
        },
      );
    },
  };
}

export function useAttentionQueue(sessionId: string, slug: string): AttentionQueue {
  const pendingPermissions = useSessionStore(
    sessionId,
    (state) => state.pendingPermissions,
    slug,
  );
  const pendingQuestions = useSessionStore(
    sessionId,
    (state) => state.pendingQuestions,
    slug,
  );
  const { mutate: postPermissionResponse } = usePostPermissionResponse();
  const { mutate: postQuestionAnswer } = usePostQuestionAnswer();

  const permissions = useMemo(
    () => mapValuesSortedById(pendingPermissions),
    [pendingPermissions],
  );
  const questions = useMemo(
    () => mapValuesSortedById(pendingQuestions),
    [pendingQuestions],
  );

  const actions = useMemo(
    () => createAttentionQueueActions({
      postPermissionResponse,
      postQuestionAnswer,
      getState: () => createWebSessionStore(sessionId, slug).getState(),
    }),
    [postPermissionResponse, postQuestionAnswer, sessionId, slug],
  );

  const respondPermission = useCallback(actions.respondPermission, [actions.respondPermission]);

  const respondQuestion = useCallback(actions.respondQuestion, [actions.respondQuestion]);

  return {
    permissions,
    questions,
    respondPermission,
    respondQuestion,
  };
}
