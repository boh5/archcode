import type { DelegationRequest, SessionExecutionRecord } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";

export interface ChildExecutionRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly toolName: "delegate";
  readonly request: DelegationRequest;
  readonly parentAbort?: AbortSignal;
}

export interface ChildExecutionOutcome {
  readonly executionStatus: SessionExecutionRecord["status"];
  /** Present only when executionStatus is completed. Empty text is valid. */
  readonly output?: string;
  readonly terminalError?: unknown;
}

export interface ChildExecutionHandle {
  readonly sessionId: string;
  readonly store: StoreApi<SessionStoreState>;
  readonly result: Promise<ChildExecutionOutcome>;
  readonly abort: () => void;
}

/** Resume preserves the durable Agent identity, Skills, title, and owned scope. */
export interface ResumeChildRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly toolName: "resume_session";
  readonly sessionId: string;
  readonly instruction: string;
  readonly background: boolean;
  readonly parentAbort?: AbortSignal;
}
