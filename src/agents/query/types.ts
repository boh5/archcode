import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../../store/types";
import type { AskUserCallback, ToolConfirmationCallback } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import type { SubAgentManagerLike as ToolSubAgentManagerLike } from "../../tools/types";
import type { SubAgentManagerLike as ContinuationSubAgentManagerLike } from "./todo-continuation";

export const DOOM_LOOP_MESSAGE = "Doom loop detected: same tool and input repeated 3 times";

export interface QueryLoopOptions {
  model: LanguageModelV3;
  toolRegistry: ToolRegistry;
  allowedTools: readonly string[];
  workspaceRoot?: string;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
  abort?: AbortSignal;
  systemPrompt?: string;
  maxSteps?: number;
  store: StoreApi<SessionStoreState>;
  subAgentManager?: ToolSubAgentManagerLike & ContinuationSubAgentManagerLike;
  currentDepth?: number;
  onRunEnd?: (state: Pick<SessionStoreState, "sessionId" | "createdAt" | "messages" | "steps" | "todos">) => Promise<void>;
}

export interface QueryLoopResult {
  text: string;
  steps: number;
}

export interface NormalizedToolCall {
  toolName: string;
  canonicalInput: string;
}
