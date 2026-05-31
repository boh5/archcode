import type { StoreApi } from "zustand";
import type { ModelCallOptions } from "../../config/provider";
import type { ModelInfo } from "../../provider/model";
import type { CommandRegistry } from "../../commands/registry";
import type { SessionStoreManager } from "../../store/session-store-manager";
import type { SessionStoreState } from "../../store/types";
import type { AskUserCallback, ToolConfirmationCallback } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import type { ProjectContext } from "../../projects/types";
import type { ChildExecutionHandle, ChildExecutionRequest } from "../../delegation/types";
import type { SkillService } from "../../skills";
import type { QueryLoopHooks } from "./loop-hooks";
import type { Logger } from "../../logger";

export const DOOM_LOOP_MESSAGE = "Doom loop detected: same tool and input repeated 3 times";

export interface QueryLoopOptions {
  modelInfo: ModelInfo;
  logger: Logger;
  modelOptions?: ModelCallOptions;
  toolRegistry: ToolRegistry;
  allowedTools: readonly string[];
  agentSkills: readonly string[];
  skillService: SkillService;
  storeManager: SessionStoreManager;
  workspaceRoot?: string;
  projectContext: ProjectContext;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
  abort?: AbortSignal;
  systemPrompt?: string;
  maxSteps?: number;
  store: StoreApi<SessionStoreState>;
  commandRegistry?: CommandRegistry;
  startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  agentName?: string;
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
