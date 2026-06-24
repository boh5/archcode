import type { StoreApi } from "zustand";
import type { WorkflowArtifactKind } from "../agents/workflow/state";
import type { SessionStoreState } from "../store/types";
import type { AgentResult } from "../agents/types";

export interface AvailableArtifactReference {
  readonly workflowId: string;
  readonly kind?: WorkflowArtifactKind;
  readonly path?: string;
  readonly description?: string;
}

export interface ChildExecutionRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly toolName: string;
  readonly targetAgentName: string;
  readonly prompt: string;
  readonly skills: readonly string[];
  readonly available_artifacts?: readonly AvailableArtifactReference[];
  readonly title?: string;
  readonly description?: string;
  readonly background?: boolean;
  readonly currentDepth?: number;
  readonly parentAbort?: AbortSignal;
}

export interface ChildExecutionHandle {
  readonly sessionId: string;
  readonly store: StoreApi<SessionStoreState>;
  readonly result: Promise<AgentResult>;
  readonly abort: () => void;
}

/**
 * Request to resume an existing (already-created) child session.
 *
 * Unlike {@link ChildExecutionRequest}, this does NOT create a new session,
 * store, agent, or child-session link. The session must already exist on disk
 * and in the session-agent cache. Resume re-runs the agent on the existing
 * store and updates the existing child-session link (no duplicate links).
 */
export interface ResumeChildRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly toolName: string;
  readonly sessionId: string;
  readonly targetAgentName: string;
  readonly prompt: string;
  readonly currentDepth?: number;
  readonly parentAbort?: AbortSignal;
}
