import type { AskUserAnswer, AskUserRequest } from "../tools/types";
import type { EventRing } from "./event-ring";

export type AskUserResponse =
  | { answers: AskUserAnswer[] }
  | { isError: true; reason: string };

type SerializableAskUserRequest = Omit<AskUserRequest, "abortSignal">;

interface PendingQuestion {
  sessionId: string;
  workspaceRoot?: string;
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
    workspaceRootOrReq: string | AskUserRequest,
    reqOrRing: AskUserRequest | EventRing,
    ringOrAbortSignal?: EventRing | AbortSignal,
    abortSignal?: AbortSignal,
  ): Promise<AskUserResponse> {
    const workspaceRoot = typeof workspaceRootOrReq === "string" ? workspaceRootOrReq : undefined;
    const req = (workspaceRoot ? reqOrRing : workspaceRootOrReq) as AskUserRequest;
    const ring = (workspaceRoot ? ringOrAbortSignal : reqOrRing) as EventRing;
    const signal = (workspaceRoot ? abortSignal : ringOrAbortSignal) as AbortSignal | undefined;
    const questionId = crypto.randomUUID();
    const serializedRequest: SerializableAskUserRequest = {
      toolName: req.toolName,
      toolCallId: req.toolCallId,
      questions: req.questions,
    };

    ring.push("question.request", JSON.stringify({ id: questionId, sessionId, ...serializedRequest }));

    if (signal?.aborted) {
      return Promise.resolve(CANCELLED_RESPONSE);
    }

    return new Promise<AskUserResponse>((resolve, reject) => {
      const pending: PendingQuestion = {
        sessionId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
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

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbortListener = () => signal.removeEventListener("abort", onAbort);
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
    }
  }
}
