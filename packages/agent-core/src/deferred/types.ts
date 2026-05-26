import type { SessionEventPayload } from "../store/index";
import type { AskUserAnswer } from "../tools/types";

export type DeferredSessionEvent = Extract<
  SessionEventPayload,
  | { type: "permission.request" }
  | { type: "permission.terminal" }
  | { type: "question.request" }
  | { type: "question.terminal" }
  | { type: "shutdown" }
>;

export type AskUserResponse =
  | { answers: AskUserAnswer[] }
  | { isError: true; reason: string };

export interface DeferredEventSubmitter {
  submitDeferredEvent(
    workspaceRoot: string,
    sessionId: string,
    event: DeferredSessionEvent,
  ): void;
}
