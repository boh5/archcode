export type { ChildExecutionHandle, ChildExecutionRequest } from "../delegation/types";
export type { AgentName } from "./names";
import type { AgentName } from "./names";
import type { RoleContract } from "../prompt/types";
import type { ProfileName } from "../config";

export interface AgentDefinition {
  readonly name: AgentName;
  readonly displayName: string;
  readonly profiles: readonly ProfileName[];
  readonly roleContract: RoleContract;
  readonly tools: AgentToolPolicy;
  readonly mcpTools?: readonly string[];
  readonly hooks: AgentHookPolicy;
  readonly childPolicy?: AgentChildPolicy;
  readonly includeMemoryInPrompt: boolean;
  readonly skills: readonly string[];
}

export interface AgentToolPolicy {
  readonly tools: readonly string[];
  readonly delegateTargets?: readonly AgentName[];
}

export interface AgentHookPolicy {
  readonly autoCompact: boolean;
  readonly autoInjectReminder: boolean;
  readonly todoStepReminder: boolean;
  readonly todoQueryLoopContinuation: boolean;
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
