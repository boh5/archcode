import type { StoreApi } from "zustand";
import type { ModelInfo } from "../../provider/model";
import type { ModelMessage } from "ai";
import type { SessionStoreState } from "../../store/types";

export interface BeforeModelBuildContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  abort?: AbortSignal;
  systemPrompt?: string;
}

export interface BeforeModelCallContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  abort?: AbortSignal;
  /** Mutable. Modifications only affect this LLM call, NOT persisted to store.
   *  To persist changes, use store.getState().append() with StreamEvent. */
  messages: ModelMessage[];
}

export interface AfterStepEndContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  abort?: AbortSignal;
}

export interface AfterLoopEndContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  abort?: AbortSignal;
}

export interface QueryLoopHooks {
  beforeModelBuild?: Array<(ctx: BeforeModelBuildContext) => Promise<void>>;
  beforeModelCall?: Array<(ctx: BeforeModelCallContext) => Promise<void>>;
  afterStepEnd?: Array<(ctx: AfterStepEndContext) => Promise<void>>;
  afterLoopEnd?: Array<(ctx: AfterLoopEndContext) => Promise<void>>;
}
