import type {
  SessionDeletionLifecycle,
  SessionDeletionOwnerDetail,
  SessionDeletionPreflightInput,
} from "../execution/session-deletion";
import { SessionDeleteOwnerConflictError } from "../execution/session-deletion";
import type { CancelSessionToolBatch } from "../execution/session-family-stop-service";
import type { SessionStoreManager } from "../store/session-store-manager";

export interface SessionLifecycleServiceOptions {
  readonly storeManager: SessionStoreManager;
  readonly cancelSessionToolBatch: CancelSessionToolBatch;
}

/** Session deletion policy kept outside the generic execution manager. */
export class SessionLifecycleService implements SessionDeletionLifecycle {
  readonly #storeManager: SessionStoreManager;
  readonly #cancelSessionToolBatch: CancelSessionToolBatch;

  constructor(options: SessionLifecycleServiceOptions) {
    this.#storeManager = options.storeManager;
    this.#cancelSessionToolBatch = options.cancelSessionToolBatch;
  }

  async assertDeletable(input: SessionDeletionPreflightInput): Promise<void> {
    const owners: SessionDeletionOwnerDetail[] = [];

    // The root owner also governs a child-only deletion request. Inspect it even
    // when the selected subtree does not contain the root itself.
    for (const sessionId of [...new Set([input.rootSessionId, ...input.sessionIds])].sort()) {
      const store = await this.#storeManager.getOrLoad(sessionId, input.workspaceRoot);
      const state = store.getState();

      if (state.goalId !== undefined) {
        owners.push({ sessionId, ownerType: "goal", ownerId: state.goalId });
      }
    }

    if (owners.length > 0) throw new SessionDeleteOwnerConflictError(owners);
  }

  async prepareForDeletion(input: SessionDeletionPreflightInput): Promise<void> {
    for (const sessionId of [...new Set(input.sessionIds)].sort()) {
      await this.#cancelSessionToolBatch(sessionId, input.workspaceRoot, "session_deleted");
    }
  }
}
