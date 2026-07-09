import type { StoreApi } from "zustand";
import type { SlashCommandResult } from "../commands/types";
import type { SessionStoreState } from "../store/types";
import type { AskUserCallback, ToolConfirmationCallback, ToolExecutionOrigin } from "../tools/index";

export interface AgentRunOptions {
  abort?: AbortSignal;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
  maxSteps?: number;
  origin?: ToolExecutionOrigin;
  extraTools?: readonly string[];
}

export interface Agent {
  readonly store: StoreApi<SessionStoreState>;
  run(
    userMessage: string,
    abort?: AbortSignal,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions): Promise<AgentResult>;
  dispatchCommand?(name: string, args?: string): Promise<SlashCommandResult>;
  /** Clean up session-scoped resources. After disposal, agent should not be used. */
  dispose(): void;
}

export interface AgentResult {
  readonly text: string;
  readonly steps: number;
}
