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
