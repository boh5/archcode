import type { AskUserRequest } from "../tools/types";
import type { AskUserResponse, DeferredEventSubmitter } from "./types";

type SerializableAskUserRequest = Omit<AskUserRequest, "abortSignal">;

interface PendingQuestion {
  sessionId: string;
  workspaceRoot: string;
  resolve(result: AskUserResponse): void;
  cleanupAbortListener?(): void;
}

const CANCELLED_RESPONSE: AskUserResponse = { isError: true, reason: "Cancelled" };

export class DeferredQuestionService {
  readonly #pending = new Map<string, PendingQuestion>();
  readonly #events: DeferredEventSubmitter;

  constructor(events: DeferredEventSubmitter) {
    this.#events = events;
  }

  request(
    sessionId: string,
    workspaceRoot: string,
    request: AskUserRequest,
  ): Promise<AskUserResponse> {
    const questionId = crypto.randomUUID();
    const serializedRequest: SerializableAskUserRequest = {
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      questions: request.questions,
      ...(request.questionType === undefined ? {} : { questionType: request.questionType }),
      ...(request.context === undefined ? {} : { context: request.context }),
    };

    this.#events.submitDeferredEvent(workspaceRoot, sessionId, {
      type: "question.request",
      questionId,
      question: JSON.stringify(serializedRequest),
      ...(request.questionType === undefined ? {} : { questionType: request.questionType }),
      ...(request.context === undefined ? {} : { context: request.context }),
    });

    if (request.abortSignal?.aborted) {
      this.#events.submitDeferredEvent(workspaceRoot, sessionId, {
        type: "question.terminal",
        questionId,
        status: "cancelled",
      });
      return Promise.resolve(CANCELLED_RESPONSE);
    }

    return new Promise<AskUserResponse>((resolve) => {
      const pending: PendingQuestion = {
        sessionId,
        workspaceRoot,
        resolve,
      };

      const onAbort = (): void => {
        if (!this.#pending.has(questionId)) return;
        this.#pending.delete(questionId);
        pending.cleanupAbortListener?.();
        this.#events.submitDeferredEvent(workspaceRoot, sessionId, {
          type: "question.terminal",
          questionId,
          status: "cancelled",
        });
        resolve(CANCELLED_RESPONSE);
      };

      if (request.abortSignal) {
        request.abortSignal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbortListener = () => request.abortSignal?.removeEventListener("abort", onAbort);
      }

      this.#pending.set(questionId, pending);
    });
  }

  respond(questionId: string, response: AskUserResponse): boolean {
    const pending = this.#pending.get(questionId);
    if (!pending) return false;

    this.#pending.delete(questionId);
    pending.cleanupAbortListener?.();
    pending.resolve(response);
    const answer = "isError" in response ? undefined : JSON.stringify(response.answers);
    this.#events.submitDeferredEvent(pending.workspaceRoot, pending.sessionId, {
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
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      if (workspaceRoot !== undefined && pending.workspaceRoot !== workspaceRoot) continue;

      this.#pending.delete(questionId);
      pending.cleanupAbortListener?.();
      pending.resolve(CANCELLED_RESPONSE);
      this.#events.submitDeferredEvent(pending.workspaceRoot, pending.sessionId, {
        type: "question.terminal",
        questionId,
        status: "cancelled",
      });
    }
  }
}
