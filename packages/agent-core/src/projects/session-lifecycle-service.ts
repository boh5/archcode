import type {
  SessionDeletionLifecycle,
  SessionDeletionPreflightInput,
} from "../execution/session-deletion";
import type { CancelSessionToolBatch } from "../execution/session-family-stop-service";
import type { SessionStoreManager } from "../store/session-store-manager";

export interface SessionLifecycleServiceOptions {
  readonly storeManager: SessionStoreManager;
  readonly cancelSessionToolBatch: CancelSessionToolBatch;
  readonly deleteToolOutputs: (
    input: SessionDeletionPreflightInput,
  ) => Promise<void>;
}

/** Session deletion policy kept outside the generic execution manager. */
export class SessionLifecycleService implements SessionDeletionLifecycle {
  readonly #storeManager: SessionStoreManager;
  readonly #cancelSessionToolBatch: CancelSessionToolBatch;
  readonly #deleteToolOutputs: SessionLifecycleServiceOptions["deleteToolOutputs"];

  constructor(options: SessionLifecycleServiceOptions) {
    this.#storeManager = options.storeManager;
    this.#cancelSessionToolBatch = options.cancelSessionToolBatch;
    this.#deleteToolOutputs = options.deleteToolOutputs;
  }

  async prepareForDeletion(input: SessionDeletionPreflightInput): Promise<void> {
    for (const sessionId of [...new Set(input.sessionIds)].sort()) {
      await this.#cancelSessionToolBatch(sessionId, input.workspaceRoot, "session_deleted");
    }
    await this.#deleteToolOutputs(input);
  }
}
