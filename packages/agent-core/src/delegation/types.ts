import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";
import type { AgentName } from "../agents/factory-types";
import type { AgentResult } from "../agents/types";

export interface DelegateAgentOptions {
  readonly parentStore: StoreApi<SessionStoreState>;
  readonly parentAgentName: AgentName;
  readonly targetAgentName: string;
  readonly prompt: string;
  readonly skills: readonly string[];
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
  delegate(options: DelegateAgentOptions): Promise<AgentRunHandle>;
}
