import type { StoreApi } from "zustand";
import type { ModelInfo } from "../../provider/model";
import type { CommandRegistry } from "../../commands/registry";
import type { SessionStoreState } from "../../store/types";
import type { AskUserCallback, ToolConfirmationCallback } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import type { SubAgentManagerLike as ToolSubAgentManagerLike } from "../../tools/types";
import type { QueryLoopHooks } from "./loop-hooks";
import type { SubAgentManagerLike as ContinuationSubAgentManagerLike } from "./todo-continuation";

export const DOOM_LOOP_MESSAGE = "Doom loop detected: same tool and input repeated 3 times";

export interface QueryLoopOptions {
  modelInfo: ModelInfo;
  toolRegistry: ToolRegistry;
  allowedTools: readonly string[];
  workspaceRoot?: string;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
  abort?: AbortSignal;
  systemPrompt?: string;
  maxSteps?: number;
  store: StoreApi<SessionStoreState>;
  commandRegistry?: CommandRegistry;
  subAgentManager?: ToolSubAgentManagerLike & ContinuationSubAgentManagerLike;
  currentDepth?: number;
  hooks?: QueryLoopHooks;
}

export interface QueryLoopResult {
  text: string;
  steps: number;
}

export interface NormalizedToolCall {
  toolName: string;
  canonicalInput: string;
}
