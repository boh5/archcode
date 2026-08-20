import type { StoreApi } from "zustand";
import type { AgentTreeProjection } from "@archcode/protocol";
import type {
  SessionExecutionSuspension,
  SessionExecutionTerminalStatus,
} from "@archcode/protocol";
import type { ExecutionModelBinding } from "../../models";
import type { SessionStoreManager } from "../../store/session-store-manager";
import type { SessionStoreState } from "../../store/types";
import type { ResolvedToolSet, ToolRegistry } from "../../tools/registry";
import type { ToolOutputAccessService } from "../../tool-output/access-service";
import type { ProjectContext } from "../../projects/types";
import type {
  CancelDescendantSession,
  ChildExecutionHandle,
  ChildExecutionRequest,
  ResumeChildRequest,
  SendMessageToChild,
} from "../../delegation/types";
import type { SkillPackageSnapshot, SkillService } from "../../skills";
import type { QueryLoopHooks } from "./loop-hooks";
import type { Logger } from "../../logger";
import type { SessionGoalService } from "../../session-goal";
import type { AttachmentModelProjector } from "../../attachments";

export const DOOM_LOOP_MESSAGE = "Doom loop detected: same tool and input repeated 3 times";

export interface QueryLoopOptions {
  executionId: string;
  runOrdinal: number;
  initialStep: number;
  binding: ExecutionModelBinding;
  logger: Logger;
  toolRegistry: ToolRegistry;
  allowedTools: readonly string[];
  agentSkills: readonly string[];
  skillService: SkillService;
  resolveSkillListTargetSkills?: (agentType: string) => readonly string[] | undefined;
  executionSkillSnapshots?: ReadonlyMap<string, SkillPackageSnapshot>;
  storeManager: SessionStoreManager;
  /** Required model-boundary attachment projection; never inferred from provider identity. */
  attachmentProjector: AttachmentModelProjector;
  /** Resolves the exact canonical attachment paths authorized for each tool execution. */
  resolveAttachmentReadPaths: () => Promise<ReadonlySet<string>>;
  /** Current Session execution directory, independent of the canonical project context. */
  cwd: string;
  projectContext: ProjectContext;
  sessionGoalService?: SessionGoalService;
  toolOutputAccess: ToolOutputAccessService;
  abort?: AbortSignal;
  systemPrompt?: string;
  /** Rebuilds lifecycle-sensitive prompt state immediately before every model call. */
  resolveSystemPrompt?: () => Promise<string>;
  /** Resolves the exact prompt and Tool descriptors used by one model attempt. */
  resolveModelBoundary?: () => Promise<{
    readonly systemPrompt?: string;
    readonly tools: ResolvedToolSet;
  }>;
  maxSteps?: number;
  store: StoreApi<SessionStoreState>;
  /** Moves this Execution's accepted steer snapshots into the canonical transcript. */
  consumeSteers?: () => Promise<void>;
  /** Materializes pending model-context domain notices at a fail-closed model boundary. */
  prepareModelContext?: () => Promise<void>;
  startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  cancelDescendantSession?: CancelDescendantSession;
  sendMessageToChild?: SendMessageToChild;
  resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  getAgentTreeProjection?: (workspaceRoot: string, rootSessionId: string) => Promise<AgentTreeProjection>;
  acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  agentName: string;
  currentDepth?: number;
  hooks?: QueryLoopHooks;
}

interface QueryLoopResultBase {
  readonly text: string;
  /** Final-eligible model attempt selected only after this QueryLoop has no further model step. */
  readonly finalOutputStepId?: string;
  /** Total canonical step cursor after this run, not a per-run reset. */
  readonly steps: number;
  readonly cwdChanged?: {
    readonly previousCwd: string;
    readonly cwd: string;
  };
}

export type QueryLoopResult =
  | QueryLoopResultBase & {
      readonly outcome: "suspended";
      readonly suspension: Exclude<SessionExecutionSuspension, { kind: "resume_pending" }>;
    }
  | QueryLoopResultBase & {
      readonly outcome: "terminal";
      readonly status: SessionExecutionTerminalStatus;
      readonly error?: string;
    };

export interface NormalizedToolCall {
  toolName: string;
  canonicalInput: string;
}
