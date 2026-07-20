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
  readonly deleteToolOutputs: (
    input: SessionDeletionPreflightInput,
  ) => Promise<void>;
  readonly findProjectTodoOwners: (
    input: SessionDeletionPreflightInput,
  ) => Promise<readonly SessionDeletionOwnerDetail[]>;
}

/** Session deletion policy kept outside the generic execution manager. */
export class SessionLifecycleService implements SessionDeletionLifecycle {
  readonly #storeManager: SessionStoreManager;
  readonly #cancelSessionToolBatch: CancelSessionToolBatch;
  readonly #deleteToolOutputs: SessionLifecycleServiceOptions["deleteToolOutputs"];
  readonly #findProjectTodoOwners: SessionLifecycleServiceOptions["findProjectTodoOwners"];

  constructor(options: SessionLifecycleServiceOptions) {
    this.#storeManager = options.storeManager;
    this.#cancelSessionToolBatch = options.cancelSessionToolBatch;
    this.#deleteToolOutputs = options.deleteToolOutputs;
    this.#findProjectTodoOwners = options.findProjectTodoOwners;
  }

  async assertDeletable(input: SessionDeletionPreflightInput): Promise<void> {
    const owners: SessionDeletionOwnerDetail[] = [];

    owners.push(...await this.#findProjectTodoOwners({
      ...input,
      sessionIds: [...new Set([input.rootSessionId, ...input.sessionIds])].sort(),
    }));

    if (owners.length > 0) throw new SessionDeleteOwnerConflictError(owners);
  }

  async prepareForDeletion(input: SessionDeletionPreflightInput): Promise<void> {
    for (const sessionId of [...new Set(input.sessionIds)].sort()) {
      await this.#cancelSessionToolBatch(sessionId, input.workspaceRoot, "session_deleted");
    }
    await this.#deleteToolOutputs(input);
  }
}
