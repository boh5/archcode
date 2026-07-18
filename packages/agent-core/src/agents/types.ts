import type { StoreApi } from "zustand";
import type { ExecutionEndEvent, SessionStoreState } from "../store/types";
import type { ExecutionModelBinding } from "../models";
import type { AskUserCallback, ToolConfirmationCallback, ToolExecutionControl } from "../tools/index";

export interface AgentCommand {
  readonly name: string;
  readonly args: string;
}

export type AgentCommandResult =
  | { readonly kind: "handled" }
  | { readonly kind: "message"; readonly content: string };

export interface AgentRunOptions {
  abort?: AbortSignal;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
  maxSteps?: number;
  extraTools?: readonly string[];
  /** Commits any steering messages to the canonical transcript before a model build. */
  consumeSteers?: () => Promise<void>;
}

export interface Agent {
  readonly store: StoreApi<SessionStoreState>;
  /** Immutable execution directory captured when this Agent runtime was built. */
  readonly cwd: string;
  /** Classify a user input before Queue admission. This method has no side effects. */
  classifyCommand(input: string): AgentCommand | null;
  /** Execute a command after the caller has enforced the command admission rules. */
  executeCommand(
    command: AgentCommand,
    binding: ExecutionModelBinding,
    options?: Pick<AgentRunOptions, "abort">,
  ): Promise<AgentCommandResult>;
  /** Run against input that is already present in the canonical Session transcript. */
  run(binding: ExecutionModelBinding, options?: AgentRunOptions): Promise<AgentResult>;
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
