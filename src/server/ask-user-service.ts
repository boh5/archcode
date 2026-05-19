import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";
import type { AskUserAnswer, AskUserRequest } from "../tools/types";

export type AskUserResponse =
  | { answers: AskUserAnswer[] }
  | { isError: true; reason: string };

type SerializableAskUserRequest = Omit<AskUserRequest, "abortSignal">;

interface PendingQuestion {
  sessionId: string;
  workspaceRoot: string;
  request: SerializableAskUserRequest;
  store: StoreApi<SessionStoreState>;
  resolve(result: AskUserResponse): void;
  reject(error: Error): void;
  cleanupAbortListener?(): void;
}

const CANCELLED_RESPONSE: AskUserResponse = { isError: true, reason: "Cancelled" };

export class AskUserService {
  #pending = new Map<string, PendingQuestion>();

  request(
    sessionId: string,
    workspaceRoot: string,
    request: AskUserRequest,
    store: StoreApi<SessionStoreState>,
    abortSignal?: AbortSignal,
  ): Promise<AskUserResponse> {
    const questionId = crypto.randomUUID();
    const serializedRequest: SerializableAskUserRequest = {
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      questions: request.questions,
    };

    store.getState().append({
      type: "question.request",
      questionId,
      question: JSON.stringify(serializedRequest),
    });

    if (abortSignal?.aborted) {
      store.getState().append({
        type: "question.terminal",
        questionId,
        status: "cancelled",
      });
      return Promise.resolve(CANCELLED_RESPONSE);
    }

    return new Promise<AskUserResponse>((resolve, reject) => {
      const pending: PendingQuestion = {
        sessionId,
        workspaceRoot,
        request: serializedRequest,
        store,
        resolve,
        reject,
      };

      const onAbort = (): void => {
        if (!this.#pending.has(questionId)) return;
        this.#pending.delete(questionId);
        pending.cleanupAbortListener?.();
        pending.store.getState().append({
          type: "question.terminal",
          questionId,
          status: "cancelled",
        });
        resolve(CANCELLED_RESPONSE);
      };

      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
      }

      this.#pending.set(questionId, pending);
    });
  }

  respond(questionId: string, response: AskUserResponse): boolean {
    const pending = this.#pending.get(questionId);
    if (!pending) {
      return false;
    }

    this.#pending.delete(questionId);
    pending.cleanupAbortListener?.();
    pending.resolve(response);
    const answer = "isError" in response ? undefined : JSON.stringify(response.answers);
    pending.store.getState().append({
      type: "question.terminal",
      questionId,
      status: answer === undefined ? "denied" : "resolved",
      answer,
    });
    return true;
  }

  has(questionId: string): boolean {
    return this.#pending.has(questionId);
  }

  cleanup(sessionId?: string, workspaceRoot?: string): void {
    for (const [questionId, pending] of this.#pending) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) {
        continue;
      }
      if (workspaceRoot !== undefined && pending.workspaceRoot !== workspaceRoot) {
        continue;
      }

      this.#pending.delete(questionId);
      pending.cleanupAbortListener?.();
      pending.resolve(CANCELLED_RESPONSE);
      pending.store.getState().append({
        type: "question.terminal",
        questionId,
        status: "cancelled",
      });
    }
  }
}
