import type { AskUserAnswer, AskUserRequest } from "../tools/types";
import type { EventRing } from "./event-ring";

export type AskUserResponse =
  | { answers: AskUserAnswer[] }
  | { isError: true; reason: string };

type SerializableAskUserRequest = Omit<AskUserRequest, "abortSignal">;

interface PendingQuestion {
  sessionId: string;
  request: SerializableAskUserRequest;
  resolve(result: AskUserResponse): void;
  reject(error: Error): void;
  cleanupAbortListener?(): void;
}

const CANCELLED_RESPONSE: AskUserResponse = { isError: true, reason: "Cancelled" };

export class AskUserService {
  #pending = new Map<string, PendingQuestion>();

  request(
    sessionId: string,
    req: AskUserRequest,
    ring: EventRing,
    abortSignal?: AbortSignal,
  ): Promise<AskUserResponse> {
    const questionId = crypto.randomUUID();
    const serializedRequest: SerializableAskUserRequest = {
      toolName: req.toolName,
      toolCallId: req.toolCallId,
      questions: req.questions,
    };

    ring.push("question.request", JSON.stringify({ id: questionId, sessionId, ...serializedRequest }));

    if (abortSignal?.aborted) {
      return Promise.resolve(CANCELLED_RESPONSE);
    }

    return new Promise<AskUserResponse>((resolve, reject) => {
      const pending: PendingQuestion = {
        sessionId,
        request: serializedRequest,
        resolve,
        reject,
      };

      const onAbort = (): void => {
        if (!this.#pending.has(questionId)) return;
        this.#pending.delete(questionId);
        pending.cleanupAbortListener?.();
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
    return true;
  }

  has(questionId: string): boolean {
    return this.#pending.has(questionId);
  }

  cleanup(sessionId?: string): void {
    for (const [questionId, pending] of this.#pending) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) {
        continue;
      }

      this.#pending.delete(questionId);
      pending.cleanupAbortListener?.();
      pending.resolve(CANCELLED_RESPONSE);
    }
  }
}
