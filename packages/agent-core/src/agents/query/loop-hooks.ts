import type { StoreApi } from "zustand";
import type {
  SessionExecutionSuspension,
  SessionExecutionTerminalStatus,
} from "@archcode/protocol";
import type { ExecutionModelBinding } from "../../models";
import type { ModelMessage } from "ai";
import type { SessionStoreState } from "../../store/types";
import type { Logger } from "../../logger";
import type { ProjectContext } from "../../projects/types";

export interface BeforeModelBuildContext {
  store: StoreApi<SessionStoreState>;
  binding: ExecutionModelBinding;
  logger: Logger;
  abort?: AbortSignal;
  systemPrompt?: string;
}

export interface BeforeModelCallContext {
  store: StoreApi<SessionStoreState>;
  binding: ExecutionModelBinding;
  logger: Logger;
  abort?: AbortSignal;
  projectContext?: ProjectContext;
  /** Mutable. Modifications only affect this LLM call, NOT persisted to store.
   *  To persist changes, use store.getState().append() with StreamEvent. */
  messages: ModelMessage[];
}

export interface AfterStepEndContext {
  store: StoreApi<SessionStoreState>;
  binding: ExecutionModelBinding;
  logger: Logger;
  abort?: AbortSignal;
  projectContext?: ProjectContext;
}

export interface AfterLoopEndContext {
  store: StoreApi<SessionStoreState>;
  binding: ExecutionModelBinding;
  logger: Logger;
  abort?: AbortSignal;
  loopOutcome:
    | {
        readonly kind: "suspended";
        readonly suspension: Exclude<SessionExecutionSuspension, { kind: "resume_pending" }>;
      }
    | {
        readonly kind: "terminal";
        readonly status: SessionExecutionTerminalStatus;
      };
  projectContext?: ProjectContext;
}

export interface QueryLoopHooks {
  beforeModelBuild?: Array<(ctx: BeforeModelBuildContext) => Promise<void>>;
  beforeModelCall?: Array<(ctx: BeforeModelCallContext) => Promise<void>>;
  afterStepEnd?: Array<(ctx: AfterStepEndContext) => Promise<void>>;
  afterLoopEnd?: Array<(ctx: AfterLoopEndContext) => Promise<void>>;
}
