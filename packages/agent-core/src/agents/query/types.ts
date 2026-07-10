import type { StoreApi } from "zustand";
import type { ModelCallOptions } from "../../config/provider";
import type { ModelInfo } from "../../provider/model";
import type { CommandRegistry } from "../../commands/registry";
import type { SessionStoreManager } from "../../store/session-store-manager";
import type { SessionStoreState } from "../../store/types";
import type { AskUserCallback, ToolConfirmationCallback, ToolExecutionControl, ToolExecutionOrigin } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import type { ProjectContext } from "../../projects/types";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../../delegation/types";
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
  /** Current Session execution directory, independent of the canonical project context. */
  cwd: string;
  projectContext: ProjectContext;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
  abort?: AbortSignal;
  systemPrompt?: string;
  maxSteps?: number;
  origin?: ToolExecutionOrigin;
  store: StoreApi<SessionStoreState>;
  commandRegistry?: CommandRegistry;
  startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  abortSessionExecutionAndWait?: (workspaceRoot: string, sessionId: string) => Promise<void>;
  acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  agentName?: string;
  currentDepth?: number;
  hooks?: QueryLoopHooks;
}

export interface QueryLoopResult {
  text: string;
  steps: number;
  executionControl?: ToolExecutionControl;
  cwdChanged?: {
    previousCwd: string;
    cwd: string;
  };
}

export interface NormalizedToolCall {
  toolName: string;
  canonicalInput: string;
}
