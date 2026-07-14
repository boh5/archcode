import type { SessionFamilyController } from "./session-family-control";
import type { SessionStoreManager } from "../store/session-store-manager";
import { collectSessionTreeIds } from "./session-tree";

export type CancelSessionToolBatch = (
  sessionId: string,
  workspaceRoot: string,
  reason: string,
) => Promise<void>;

export interface SessionFamilyStopServiceOptions {
  readonly sessionFamilyController: SessionFamilyController;
  readonly sessionStoreManager: SessionStoreManager;
  readonly cancelSessionToolBatch: CancelSessionToolBatch;
}

/** Strong family Stop: drain live work, then clear durable Session attention while ownership remains exclusive. */
export class SessionFamilyStopService {
  readonly #sessionFamilyController: SessionFamilyController;
  readonly #sessionStoreManager: SessionStoreManager;
  readonly #cancelSessionToolBatch: CancelSessionToolBatch;

  constructor(options: SessionFamilyStopServiceOptions) {
    this.#sessionFamilyController = options.sessionFamilyController;
    this.#sessionStoreManager = options.sessionStoreManager;
    this.#cancelSessionToolBatch = options.cancelSessionToolBatch;
  }

  async stop(workspaceRoot: string, rootSessionId: string): Promise<void> {
    const lease = this.#sessionFamilyController.acquireStop({ workspaceRoot, rootSessionId });
    try {
      await lease.stopAndWait();
      const tree = await this.#sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId);
      for (const sessionId of collectSessionTreeIds(tree.root)) {
        await this.#cancelSessionToolBatch(sessionId, workspaceRoot, "session_family_stopped");
      }
    } finally {
      lease.release();
    }
  }
}
