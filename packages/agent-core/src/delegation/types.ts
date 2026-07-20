import type { StoreApi } from "zustand";
import type {
  ChildResultReceipt,
  DelegationContract,
  DelegationEvidence,
  SessionExecutionRecord,
} from "@archcode/protocol";
import type { SessionStoreState } from "../store/types";

export interface ChildExecutionRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly toolName: "delegate";
  readonly contract: DelegationContract;
  readonly parentAbort?: AbortSignal;
}

/**
 * Runtime-only provenance for the mandatory Session Goal completion review.
 * Unlike a normal delegation this does not pretend that a model-visible
 * `delegate` tool call exists. The caller pre-mints both durable identities so
 * the Goal claim can be checkpointed before the child is started.
 */
export interface RuntimeGoalReviewChildRequest {
  readonly provenance: {
    readonly kind: "goal_review";
    readonly reviewClaimId: string;
  };
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly reviewerSessionId: string;
  readonly reviewerExecutionId: string;
  readonly contract: DelegationContract;
}

/** Parent-facing execution outcome. Task status lives only in resultReceipt. */
export interface ChildExecutionOutcome {
  readonly executionStatus: SessionExecutionRecord["status"];
  readonly resultReceipt?: ChildResultReceipt;
  readonly terminalError?: unknown;
}

export interface ChildExecutionHandle {
  readonly sessionId: string;
  readonly store: StoreApi<SessionStoreState>;
  readonly result: Promise<ChildExecutionOutcome>;
  readonly abort: () => void;
}

/**
 * Request to resume an existing direct child without changing its durable
 * delegation identity, ownership, Skills, title, or acceptance criteria.
 */
export interface ResumeChildRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly toolName: "resume_session";
  readonly sessionId: string;
  readonly instruction: string;
  readonly newEvidence: readonly DelegationEvidence[];
  readonly background: boolean;
  readonly parentAbort?: AbortSignal;
}
