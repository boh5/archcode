import type { StoreApi } from "zustand/vanilla";
import type { ModelCallOptions } from "../config/provider";
import type { SessionStoreState } from "../store/types";
import type { ModelInfo } from "../provider/model";
import type { Logger } from "../logger";

export interface BackgroundTaskContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  logger: Logger;
  modelOptions?: ModelCallOptions;
  workspaceRoot: string;
  abort?: AbortSignal;
}

export interface BackgroundTask {
  name: string;
  run: (ctx: BackgroundTaskContext) => Promise<void>;
}
