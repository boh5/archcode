export type { ChildExecutionHandle, ChildExecutionRequest } from "../delegation/types";

export type AgentName = "orchestrator" | "explore" | (string & {});

export interface AgentDefinition {
  readonly name: AgentName;
  readonly promptProfileId: string;
  readonly rolePrompt?: string;
  readonly tools: AgentToolPolicy;
  readonly hooks: AgentHookPolicy;
  readonly childPolicy?: AgentChildPolicy;
  readonly includeMemoryInPrompt: boolean;
  readonly enforceToolOutputQuota?: boolean;
  readonly skills: readonly string[];
}

export interface AgentToolPolicy {
  readonly tools: readonly string[];
  readonly delegateTargets?: readonly AgentName[];
}

export interface AgentHookPolicy {
  readonly autoCompact: boolean;
  readonly autoInjectReminder: boolean;
  readonly todoContinuation: boolean;
  readonly transcriptSave: boolean;
  readonly memoryExtraction: boolean;
  readonly memoryConsolidation: boolean;
  readonly titleGeneration: "enabled" | "disabled" | "unless-supplied";
}

export interface AgentChildPolicy {
  readonly maxDepth: number;
  readonly maxConcurrent: number;
  readonly timeoutMs: number;
  readonly abortCascade: boolean;
  readonly terminalReminders: boolean;
}
