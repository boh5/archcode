import type { StoreApi } from "zustand";
import type { ModelCallOptions } from "../../config/provider";
import type { ModelInfo } from "../../provider/model";
import type { ModelMessage } from "ai";
import type { ExecutionEndEvent, SessionStoreState } from "../../store/types";
import type { Logger } from "../../logger";

export interface BeforeModelBuildContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  logger: Logger;
  modelOptions?: ModelCallOptions;
  abort?: AbortSignal;
  systemPrompt?: string;
}

export interface BeforeModelCallContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  logger: Logger;
  modelOptions?: ModelCallOptions;
  abort?: AbortSignal;
  /** Mutable. Modifications only affect this LLM call, NOT persisted to store.
   *  To persist changes, use store.getState().append() with StreamEvent. */
  messages: ModelMessage[];
}

export interface AfterStepEndContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  logger: Logger;
  modelOptions?: ModelCallOptions;
  abort?: AbortSignal;
}

export interface AfterLoopEndContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  logger: Logger;
  modelOptions?: ModelCallOptions;
  abort?: AbortSignal;
  loopEndStatus: ExecutionEndEvent["status"];
}

export interface QueryLoopHooks {
  beforeModelBuild?: Array<(ctx: BeforeModelBuildContext) => Promise<void>>;
  beforeModelCall?: Array<(ctx: BeforeModelCallContext) => Promise<void>>;
  afterStepEnd?: Array<(ctx: AfterStepEndContext) => Promise<void>>;
  afterLoopEnd?: Array<(ctx: AfterLoopEndContext) => Promise<void>>;
}
