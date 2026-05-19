import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";
import type { AskUserCallback, ToolConfirmationCallback } from "../tools/index";

export interface AgentRunOptions {
  abort?: AbortSignal;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
}

export interface Agent {
  readonly store: StoreApi<SessionStoreState>;
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
}
