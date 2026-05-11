import type { StoreApi } from "zustand/vanilla";
import type { SessionStoreState } from "../store/types";
import type { ModelInfo } from "../provider/model";
import type { Registry as ProviderRegistry } from "../provider/registry";

export interface BackgroundTaskContext {
  store: StoreApi<SessionStoreState>;
  modelInfo: ModelInfo;
  providerRegistry: ProviderRegistry;
  workspaceRoot: string;
  sessionsDir: string;
  abort?: AbortSignal;
}

export interface BackgroundTask {
  name: string;
  run: (ctx: BackgroundTaskContext) => Promise<void>;
}
