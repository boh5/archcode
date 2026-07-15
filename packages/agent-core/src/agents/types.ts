import type { StoreApi } from "zustand";
import type { ExecutionEndEvent, SessionStoreState } from "../store/types";
import type { AskUserCallback, ToolConfirmationCallback, ToolExecutionControl } from "../tools/index";

export interface AgentRunOptions {
  abort?: AbortSignal;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
  maxSteps?: number;
  extraTools?: readonly string[];
}

export interface Agent {
  readonly store: StoreApi<SessionStoreState>;
  /** Immutable execution directory captured when this Agent runtime was built. */
  readonly cwd: string;
  run(
    userMessage: string,
    abort?: AbortSignal,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions): Promise<AgentResult>;
  /** Clean up session-scoped resources. After disposal, agent should not be used. */
  dispose(): void;
}

export interface AgentResult {
  readonly text: string;
  readonly steps: number;
  readonly status: ExecutionEndEvent["status"];
  readonly error?: string;
  readonly executionControl?: ToolExecutionControl;
  readonly cwdChanged?: {
    readonly previousCwd: string;
    readonly cwd: string;
  };
}
