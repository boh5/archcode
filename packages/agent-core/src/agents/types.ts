import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";
import type { ExecutionModelBinding } from "../models";
import type { QueryLoopResult } from "./query";
import type { SkillPackageSnapshot } from "../skills";
import type { MemoryPolicySnapshot } from "../memory";

export interface AgentCommand {
  readonly name: string;
  readonly args: string;
}

export type AgentCommandResult =
  | { readonly kind: "handled" }
  | {
      readonly kind: "message";
      readonly content: string;
      readonly executionSkillNames: readonly string[];
    };

export interface AgentRunOptions {
  abort?: AbortSignal;
  /** Logical Execution owning this live run. */
  executionId: string;
  /** Stable zero-based ordinal of this live run within the logical Execution. */
  runOrdinal: number;
  /** First canonical step index available to this run. */
  initialStep: number;
  maxSteps?: number;
  extraTools?: readonly string[];
  /** Runtime-owned strict subset of the role's normal tool projection. */
  toolProjection?: readonly string[];
  /** Commits any steering messages to the canonical transcript before a model build. */
  consumeSteers?: () => Promise<void>;
  /** Immutable one-shot Skill packages owned by this logical Execution. */
  executionSkillSnapshots?: ReadonlyMap<string, SkillPackageSnapshot>;
  /** Immutable Memory policy captured with the owning logical Execution. */
  memoryPolicy: MemoryPolicySnapshot;
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

export type AgentResult = QueryLoopResult;
