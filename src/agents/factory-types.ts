import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";
import type { AgentResult } from "./types";

export type AgentName = "orchestrator" | "explore" | (string & {});

export interface DelegateAgentOptions {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentAgentName: AgentName;
  readonly targetAgentName: string;
  readonly prompt: string;
  readonly title?: string;
  readonly description?: string;
  readonly background?: boolean;
  readonly currentDepth?: number;
  readonly parentAbort?: AbortSignal;
}

export interface AgentRunHandle {
  readonly sessionId: string;
  readonly store: StoreApi<SessionStoreState>;
  readonly result: Promise<AgentResult>;
  readonly abort: () => void;
}

export interface AgentFactoryLike {
  delegate(options: DelegateAgentOptions): AgentRunHandle;
}

export interface AgentDefinition {
  readonly name: AgentName;
  readonly promptAgentId: string;
  readonly rolePrompt?: string;
  readonly tools: AgentToolPolicy;
  readonly hooks: AgentHookPolicy;
  readonly childPolicy?: AgentChildPolicy;
  readonly includeMemoryInPrompt: boolean;
  readonly enforceToolOutputQuota?: boolean;
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
