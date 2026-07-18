import type { StoreApi } from "zustand/vanilla";
import type { SessionStoreState } from "../store/types";
import type { ExecutionModelBinding } from "../models";
import type { Logger } from "../logger";
import type { RetryScheduler } from "../llm/retry";

export interface BackgroundTaskContext {
  store: StoreApi<SessionStoreState>;
  binding: ExecutionModelBinding;
  logger: Logger;
  workspaceRoot: string;
  abort?: AbortSignal;
  retryScheduler?: RetryScheduler;
}

export interface BackgroundTask {
  name: string;
  run: (ctx: BackgroundTaskContext) => Promise<void>;
}
