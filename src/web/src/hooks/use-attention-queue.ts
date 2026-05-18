import { useCallback, useMemo } from "react";
import { usePostPermissionResponse, usePostQuestionAnswer } from "../api/mutations";
import type {
  PermissionDecision,
  PermissionRequest,
  QuestionAnswerBody,
  QuestionRequest,
} from "../api/types";
import { createWebSessionStore, useSessionStore } from "../store/session-store";

export interface AttentionQueue {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  respondPermission: (id: string, response: PermissionDecision) => void;
  respondQuestion: (id: string, body: QuestionAnswerBody) => void;
}

function mapValuesSortedById<T extends { id: string }>(items: Map<string, T>): T[] {
  return [...items.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function useAttentionQueue(sessionId: string): AttentionQueue {
  const pendingPermissions = useSessionStore(
    sessionId,
    (state) => state.pendingPermissions,
  );
  const pendingQuestions = useSessionStore(
    sessionId,
    (state) => state.pendingQuestions,
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

  const respondPermission = useCallback(
    (id: string, response: PermissionDecision) => {
      postPermissionResponse(
        { id, decision: response },
        {
          onSuccess: () => {
            createWebSessionStore(sessionId).getState().removePermissionRequest(id);
          },
        },
      );
    },
    [postPermissionResponse, sessionId],
  );

  const respondQuestion = useCallback(
    (id: string, body: QuestionAnswerBody) => {
      postQuestionAnswer(
        { id, body },
        {
          onSuccess: () => {
            createWebSessionStore(sessionId).getState().removeQuestionRequest(id);
          },
        },
      );
    },
    [postQuestionAnswer, sessionId],
  );

  return {
    permissions,
    questions,
    respondPermission,
    respondQuestion,
  };
}
