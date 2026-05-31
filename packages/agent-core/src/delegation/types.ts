import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";
import type { AgentResult } from "../agents/types";

export interface ChildExecutionRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly toolName: string;
  readonly targetAgentName: string;
  readonly prompt: string;
  readonly skills: readonly string[];
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
