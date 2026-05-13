import type { StoreApi } from "zustand/vanilla";
import type { SessionStoreState } from "../store/types";
import type { ModelInfo } from "../provider/model";

export interface BackgroundTaskContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  workspaceRoot: string;
  abort?: AbortSignal;
}

export interface BackgroundTask {
  name: string;
  run: (ctx: BackgroundTaskContext) => Promise<void>;
}