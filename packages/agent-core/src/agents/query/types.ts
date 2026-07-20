import type { StoreApi } from "zustand";
import type { ExecutionModelBinding } from "../../models";
import type { SessionStoreManager } from "../../store/session-store-manager";
import type { ExecutionEndEvent, SessionStoreState } from "../../store/types";
import type { ToolExecutionControl } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import type { ToolOutputAccessService } from "../../tool-output/access-service";
import type { ProjectContext } from "../../projects/types";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../../delegation/types";
import type { SkillService } from "../../skills";
import type { QueryLoopHooks } from "./loop-hooks";
import type { Logger } from "../../logger";
import type { ConsumeFreshUserInputRequest, FreshUserInputGrant } from "../../tools/types";
import type { SessionGoalService } from "../../session-goal";

export const DOOM_LOOP_MESSAGE = "Doom loop detected: same tool and input repeated 3 times";

export interface QueryLoopOptions {
  binding: ExecutionModelBinding;
  logger: Logger;
  toolRegistry: ToolRegistry;
  allowedTools: readonly string[];
  agentSkills: readonly string[];
  skillService: SkillService;
  storeManager: SessionStoreManager;
  /** Current Session execution directory, independent of the canonical project context. */
  cwd: string;
  projectContext: ProjectContext;
  sessionGoalService?: SessionGoalService;
  consumeFreshUserInput?: (input: ConsumeFreshUserInputRequest) => Promise<FreshUserInputGrant> | FreshUserInputGrant;
  toolOutputAccess: ToolOutputAccessService;
  abort?: AbortSignal;
  systemPrompt?: string;
  /** Rebuilds lifecycle-sensitive prompt state immediately before every model call. */
  resolveSystemPrompt?: () => Promise<string>;
  maxSteps?: number;
  store: StoreApi<SessionStoreState>;
  /** Moves this Execution's accepted steer snapshots into the canonical transcript. */
  consumeSteers?: () => Promise<void>;
  startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  agentName: string;
  currentDepth?: number;
  hooks?: QueryLoopHooks;
}

export interface QueryLoopResult {
  text: string;
  steps: number;
  status: ExecutionEndEvent["status"];
  error?: string;
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
