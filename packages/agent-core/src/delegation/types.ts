import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";
import type { AgentResult } from "../agents/types";
import type { ToolExecutionOrigin } from "../tools/types";

export interface ChildExecutionRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly toolName: string;
  readonly targetAgentName: string;
  readonly prompt: string;
  readonly persona?: string;
  readonly skills: readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly background?: boolean;
  readonly currentDepth?: number;
  readonly parentAbort?: AbortSignal;
  /** Preserves Loop run authority and guardrails across delegated execution. */
  readonly origin?: ToolExecutionOrigin;
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
 * store, or agent. The session must already exist on disk and in the
 * session-agent cache. Resume re-runs the agent on the existing store and
 * creates a parent child-session link for the current resume tool call.
 */
export interface ResumeChildRequest {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentSessionId: string;
  readonly parentToolCallId: string;
  readonly toolName: string;
  readonly sessionId: string;
  readonly targetAgentName: string;
  readonly prompt: string;
  readonly background?: boolean;
  readonly currentDepth?: number;
  readonly parentAbort?: AbortSignal;
  /** Preserves Loop run authority and guardrails across delegated continuation. */
  readonly origin?: ToolExecutionOrigin;
}
