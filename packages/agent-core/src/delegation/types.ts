import type {
  DelegationRequest,
  SessionExecutionSuspension,
  SessionExecutionTerminalStatus,
} from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";

export interface ChildExecutionRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentExecutionId: string;
  readonly parentRunOrdinal: number;
  readonly parentToolBatchId: string;
  readonly parentToolCallId: string;
  readonly childSessionId: string;
  readonly childExecutionId: string;
  readonly toolName: "delegate";
  readonly request: DelegationRequest;
  readonly parentAbort?: AbortSignal;
}

export type ChildExecutionOutcome =
  | {
      readonly outcome: "suspended";
      readonly executionId: string;
      readonly suspension: Extract<SessionExecutionSuspension, { kind: "hitl" | "child_dependency" }>;
    }
  | {
      readonly outcome: "terminal";
      readonly executionId: string;
      readonly executionStatus: SessionExecutionTerminalStatus;
      /** Present only when executionStatus is completed. Empty text is valid. */
      readonly output?: string;
      readonly terminalError?: unknown;
    };

export interface ChildExecutionHandle {
  readonly sessionId: string;
  readonly executionId: string;
  readonly store: StoreApi<SessionStoreState>;
  readonly result: Promise<ChildExecutionOutcome>;
  readonly abort: () => void;
}

/** Resume preserves the durable Agent identity, Profile, Skills, title, and objective. */
export interface ResumeChildRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentExecutionId: string;
  readonly parentRunOrdinal: number;
  readonly parentToolBatchId: string;
  readonly parentToolCallId: string;
  readonly toolName: "resume_session";
  readonly sessionId: string;
  readonly childExecutionId: string;
  readonly instruction: string;
  readonly background: boolean;
  readonly parentAbort?: AbortSignal;
}

export interface ParentAgentMessageRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentAgentName: string;
  readonly parentExecutionId: string;
  readonly parentRunOrdinal: number;
  readonly parentToolBatchId: string;
  readonly parentToolCallId: string;
  readonly sessionId: string;
  readonly expectedExecutionId: string;
  readonly message: string;
  readonly delivery: "steer" | "queue";
  readonly clientRequestId: string;
}

export interface ParentAgentMessageResult {
  readonly sessionId: string;
  readonly executionId: string;
  readonly messageId: string;
  readonly delivery: "steered" | "queued";
}

export type SendMessageToChild = (
  workspaceRoot: string,
  request: ParentAgentMessageRequest,
) => Promise<ParentAgentMessageResult>;

export type CancelDescendantSession = (
  workspaceRoot: string,
  parentSessionId: string,
  childSessionId: string,
) => Promise<"cancelled" | "already_stopped">;
